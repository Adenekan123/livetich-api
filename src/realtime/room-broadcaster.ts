import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { ServerToClientEvents } from '../shared';

/** The socket room only the instructor/admins of a session join — used for
 *  staff-only pushes (e.g. incoming submissions) so student PII never fans out
 *  to peer students. RoomGateway joins staff to it on room:join. */
export const staffRoom = (sessionId: string) => `${sessionId}::staff`;

/**
 * A thin seam for non-socket code (HTTP controllers/services) to push events
 * into a live-session room. RoomGateway binds its socket server here on init,
 * so callers emit without importing the gateway (no module cycle).
 */
@Injectable()
export class RoomBroadcaster {
  private server: Server<Record<string, unknown>, ServerToClientEvents> | null =
    null;

  bind(server: Server<Record<string, unknown>, ServerToClientEvents>) {
    this.server = server;
  }

  /** Emit to everyone in a session room (students included). */
  emitToSession<E extends keyof ServerToClientEvents>(
    sessionId: string,
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ) {
    (this.server?.to(sessionId).emit as (e: E, p: unknown) => void)?.(
      event,
      payload,
    );
  }

  /** Emit to the instructor/admins of a session (not students). */
  emitToSessionStaff<E extends keyof ServerToClientEvents>(
    sessionId: string,
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ) {
    // socket.io's typed emit is variadic; our events all take one payload.
    (this.server?.to(staffRoom(sessionId)).emit as (e: E, p: unknown) => void)?.(
      event,
      payload,
    );
  }

  /**
   * Disconnects a specific user's socket connections from a live session.
   * Sends room:closed with an eviction reason and terminates the connection.
   */
  async evictUserFromSession(
    sessionId: string,
    userId: string,
    reason = 'ACCESS_REVOKED',
  ): Promise<void> {
    if (!this.server) return;
    try {
      const sockets = await this.server.in(sessionId).fetchSockets();
      for (const socket of sockets) {
        if ((socket.data as { user?: { sub?: string } })?.user?.sub === userId) {
          (socket.emit as (e: string, p: unknown) => void)('room:closed', {
            sessionId,
            reason,
          });
          socket.leave(sessionId);
          socket.disconnect(true);
        }
      }
    } catch {
      // Best-effort
    }
  }

  /**
   * Disconnects a user across all active sessions (e.g. account disabled or revoked).
   */
  async evictUserGlobally(
    userId: string,
    reason = 'ACCOUNT_DISABLED',
  ): Promise<void> {
    if (!this.server) return;
    try {
      const sockets = await this.server.fetchSockets();
      for (const socket of sockets) {
        if ((socket.data as { user?: { sub?: string } })?.user?.sub === userId) {
          (socket.emit as (e: string, p: unknown) => void)('error', {
            code: 'FORBIDDEN',
            message: reason,
          });
          socket.disconnect(true);
        }
      }
    } catch {
      // Best-effort
    }
  }
}
