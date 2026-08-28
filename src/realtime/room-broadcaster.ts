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
}
