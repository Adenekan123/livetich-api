import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import type { TerminalSessionInfo, TerminalWritableMode } from '../shared';

interface ActiveTerminal {
  info: TerminalSessionInfo;
  hostSocketId: string;
  hostUserId: string;
  backlog: string;
}

/**
 * In-memory manager for live terminal streaming sessions.
 * Designed for 2 vCPU / 4GB RAM efficiency:
 * - Streams raw ANSI chunks directly with zero disk I/O.
 * - Caps backlog buffer at 64KB per terminal (preventing unbounded heap growth).
 * - Immediately frees session buffers when terminals close or hosts disconnect.
 */
@Injectable()
export class TerminalService {
  private static readonly MAX_BACKLOG_BYTES = 64 * 1024; // 64KB max ring buffer per terminal
  private readonly logger = new Logger(TerminalService.name);

  // Map: sessionId -> Map<terminalId, ActiveTerminal>
  private readonly sessions = new Map<string, Map<string, ActiveTerminal>>();

  openTerminal(
    sessionId: string,
    info: TerminalSessionInfo,
    hostSocketId: string,
    hostUserId: string,
  ): void {
    let termMap = this.sessions.get(sessionId);
    if (!termMap) {
      termMap = new Map();
      this.sessions.set(sessionId, termMap);
    }
    termMap.set(info.terminalId, {
      info,
      hostSocketId,
      hostUserId,
      backlog: '',
    });
  }

  appendData(
    sessionId: string,
    terminalId: string,
    chunk: string | Uint8Array,
  ): void {
    const term = this.sessions.get(sessionId)?.get(terminalId);
    if (!term) return;

    const str =
      typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk).toString('utf-8');

    term.backlog += str;
    if (term.backlog.length > TerminalService.MAX_BACKLOG_BYTES) {
      term.backlog = term.backlog.slice(-TerminalService.MAX_BACKLOG_BYTES);
    }
  }

  resizeTerminal(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    const term = this.sessions.get(sessionId)?.get(terminalId);
    if (term) {
      term.info.cols = cols;
      term.info.rows = rows;
    }
  }

  updatePermission(
    sessionId: string,
    terminalId: string,
    writableBy: TerminalWritableMode,
    delegatedUserIds?: string[],
  ): void {
    const term = this.sessions.get(sessionId)?.get(terminalId);
    if (term) {
      term.info.writableBy = writableBy;
      term.info.delegatedUserIds = delegatedUserIds;
    }
  }

  closeTerminal(sessionId: string, terminalId: string): void {
    const termMap = this.sessions.get(sessionId);
    if (!termMap) return;
    termMap.delete(terminalId);
    if (termMap.size === 0) {
      this.sessions.delete(sessionId);
    }
  }

  getTerminalsForSession(
    sessionId: string,
  ): Array<TerminalSessionInfo & { backlog?: string }> {
    const termMap = this.sessions.get(sessionId);
    if (!termMap) return [];
    return Array.from(termMap.values()).map((t) => ({
      ...t.info,
      backlog: t.backlog,
    }));
  }

  getHostSocketId(sessionId: string, terminalId: string): string | undefined {
    return this.sessions.get(sessionId)?.get(terminalId)?.hostSocketId;
  }

  isSandboxed(sessionId: string, terminalId: string): boolean {
    return this.sessions.get(sessionId)?.get(terminalId)?.info.sandboxed === true;
  }

  isHostSocket(sessionId: string, terminalId: string, socketId: string): boolean {
    return this.getHostSocketId(sessionId, terminalId) === socketId;
  }

  canSendStdin(
    sessionId: string,
    terminalId: string,
    user: JwtPayload,
    socketId: string,
  ): boolean {
    const term = this.sessions.get(sessionId)?.get(terminalId);
    if (!term || !term.info.interactive) return false;

    if (term.info.sandboxed) {
      if (user.role === Role.INSTRUCTOR || user.role === Role.ORG_ADMIN) return true;
      if (term.info.writableBy === 'OPEN') return true;
      if (term.info.writableBy === 'DELEGATED') {
        return Boolean(term.info.delegatedUserIds?.includes(user.sub));
      }
      return false;
    }

    // Legacy terminals are local host shells and never accept remote input.
    return term.hostUserId === user.sub && term.hostSocketId === socketId;
  }

  cleanupSocket(
    socketId: string,
  ): Array<{ sessionId: string; terminalId: string }> {
    const closed: Array<{ sessionId: string; terminalId: string }> = [];
    for (const [sessionId, termMap] of this.sessions.entries()) {
      for (const [termId, term] of termMap.entries()) {
        if (term.hostSocketId === socketId) {
          termMap.delete(termId);
          closed.push({ sessionId, terminalId: termId });
        }
      }
      if (termMap.size === 0) {
        this.sessions.delete(sessionId);
      }
    }
    return closed;
  }

  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
