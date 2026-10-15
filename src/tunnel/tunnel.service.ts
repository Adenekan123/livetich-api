import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { ForwardedPortInfo } from '../shared';

export interface PendingTunnelRequest {
  reqId: string;
  res: Response;
  timer: NodeJS.Timeout;
  headersSent: boolean;
}

interface ActivePort {
  sessionId: string;
  port: number;
  label?: string;
  targetUrl: string;
  hostSocketId: string;
  hostUserId: string;
  registeredAt: string;
}

/**
 * Service managing localhost port-forwarding tunnels and streaming HTTP proxy requests.
 * Zero-memory accumulation: streams chunks directly to Express response objects.
 */
@Injectable()
export class TunnelService {
  private readonly logger = new Logger(TunnelService.name);

  // Map: `${sessionId}:${port}` -> ActivePort
  private readonly ports = new Map<string, ActivePort>();

  // Map: reqId -> PendingTunnelRequest
  private readonly pendingRequests = new Map<string, PendingTunnelRequest>();

  private portKey(sessionId: string, port: number): string {
    return `${sessionId}:${port}`;
  }

  registerPort(
    sessionId: string,
    port: number,
    label: string | undefined,
    hostSocketId: string,
    hostUserId: string,
  ): ForwardedPortInfo {
    const key = this.portKey(sessionId, port);
    const info: ActivePort = {
      sessionId,
      port,
      label,
      targetUrl: `http://localhost:${port}`,
      hostSocketId,
      hostUserId,
      registeredAt: new Date().toISOString(),
    };
    this.ports.set(key, info);
    return {
      port: info.port,
      label: info.label,
      targetUrl: info.targetUrl,
      registeredAt: info.registeredAt,
    };
  }

  unregisterPort(sessionId: string, port: number): boolean {
    const key = this.portKey(sessionId, port);
    return this.ports.delete(key);
  }

  getPortsForSession(sessionId: string): ForwardedPortInfo[] {
    const list: ForwardedPortInfo[] = [];
    for (const p of this.ports.values()) {
      if (p.sessionId === sessionId) {
        list.push({
          port: p.port,
          label: p.label,
          targetUrl: p.targetUrl,
          registeredAt: p.registeredAt,
        });
      }
    }
    return list;
  }

  getHostSocketForPort(sessionId: string, port: number): string | undefined {
    return this.ports.get(this.portKey(sessionId, port))?.hostSocketId;
  }

  cleanupSocket(
    socketId: string,
  ): Array<{ sessionId: string; port: number }> {
    const removed: Array<{ sessionId: string; port: number }> = [];
    for (const [key, p] of this.ports.entries()) {
      if (p.hostSocketId === socketId) {
        this.ports.delete(key);
        removed.push({ sessionId: p.sessionId, port: p.port });
      }
    }
    return removed;
  }

  // --- HTTP Request Lifecycle ---

  registerPendingRequest(
    reqId: string,
    res: Response,
    onTimeout: () => void,
  ): void {
    const timer = setTimeout(() => {
      this.handleTimeout(reqId, onTimeout);
    }, 30_000); // 30s max timeout

    this.pendingRequests.set(reqId, {
      reqId,
      res,
      timer,
      headersSent: false,
    });
  }

  handleResponseHeaders(
    reqId: string,
    statusCode: number,
    headers: Record<string, string | string[]>,
  ): boolean {
    const pending = this.pendingRequests.get(reqId);
    if (!pending || pending.headersSent) return false;

    pending.headersSent = true;
    const res = pending.res;

    // Sanitize headers: remove hop-by-hop headers
    const sanitized: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      // Allow embedding in classroom preview iframe:
      if (lower === 'x-frame-options' || lower === 'frame-ancestors') {
        continue;
      }
      if (
        lower === 'transfer-encoding' ||
        lower === 'connection' ||
        lower === 'keep-alive'
      ) {
        continue;
      }
      sanitized[k] = v;
    }

    try {
      res.status(statusCode);
      for (const [k, v] of Object.entries(sanitized)) {
        res.setHeader(k, v);
      }
      return true;
    } catch (e) {
      this.logger.error(`Failed to set headers for ${reqId}: ${String(e)}`);
      return false;
    }
  }

  handleResponseChunk(
    reqId: string,
    chunk: string,
    isBase64?: boolean,
  ): boolean {
    const pending = this.pendingRequests.get(reqId);
    if (!pending) return false;

    try {
      const buf = isBase64
        ? Buffer.from(chunk, 'base64')
        : Buffer.from(chunk, 'utf-8');
      pending.res.write(buf);
      return true;
    } catch (e) {
      this.logger.error(`Failed to write chunk for ${reqId}: ${String(e)}`);
      return false;
    }
  }

  handleResponseEnd(reqId: string): void {
    const pending = this.pendingRequests.get(reqId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(reqId);

    try {
      pending.res.end();
    } catch (e) {
      this.logger.warn(`Failed to end response for ${reqId}: ${String(e)}`);
    }
  }

  handleResponseError(reqId: string, message: string): void {
    const pending = this.pendingRequests.get(reqId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(reqId);

    try {
      if (!pending.headersSent) {
        pending.res.status(502).json({
          error: 'TUNNEL_ERROR',
          message: `Forwarded host error: ${message}`,
        });
      } else {
        pending.res.end();
      }
    } catch {
      // Ignored
    }
  }

  abortRequest(reqId: string): void {
    const pending = this.pendingRequests.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(reqId);
  }

  private handleTimeout(reqId: string, onTimeout: () => void): void {
    const pending = this.pendingRequests.get(reqId);
    if (!pending) return;

    this.pendingRequests.delete(reqId);
    onTimeout();

    try {
      if (!pending.headersSent) {
        pending.res.status(504).json({
          error: 'GATEWAY_TIMEOUT',
          message: 'The forwarded localhost server timed out responding.',
        });
      } else {
        pending.res.end();
      }
    } catch {
      // Ignored
    }
  }
}
