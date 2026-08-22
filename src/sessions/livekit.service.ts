import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

@Injectable()
export class LivekitService {
  constructor(private readonly config: ConfigService) {}

  get url(): string {
    return this.config.get<string>('LIVEKIT_URL') ?? '';
  }

  /**
   * Join token for a room. Everyone — instructor and students — may publish
   * mic, camera and screen share (all start muted client-side; the classroom
   * bar drives what's actually on air). Subscribe is always granted.
   */
  async mintJoinToken(opts: {
    room: string;
    userId: string;
    name: string;
    role: Role;
    /** Shadow observer (admin): invisible to others, can't publish. */
    hidden?: boolean;
  }): Promise<string> {
    const key = this.config.get<string>('LIVEKIT_API_KEY');
    const secret = this.config.get<string>('LIVEKIT_API_SECRET');
    if (!key || !secret) {
      throw new ServiceUnavailableException('LiveKit is not configured');
    }
    const at = new AccessToken(key, secret, {
      identity: opts.userId,
      name: opts.name,
      metadata: JSON.stringify({ role: opts.role }),
      ttl: '6h',
    });
    at.addGrant({
      roomJoin: true,
      room: opts.room,
      // A hidden participant can watch/listen but never appears in anyone
      // else's participant list and publishes nothing — the shadow-join case.
      canPublish: !opts.hidden,
      canSubscribe: true,
      canPublishData: !opts.hidden,
      hidden: opts.hidden ?? false,
    });
    return at.toJwt();
  }

  /**
   * Toggle a participant's publish rights (screen-share grant/revoke).
   * Requires reachable LiveKit server credentials.
   */
  async setPublishPermission(room: string, identity: string, canPublish: boolean) {
    const url = this.config.get<string>('LIVEKIT_URL');
    const key = this.config.get<string>('LIVEKIT_API_KEY');
    const secret = this.config.get<string>('LIVEKIT_API_SECRET');
    if (!url || !key || !secret) {
      throw new ServiceUnavailableException('LiveKit is not configured');
    }
    const client = new RoomServiceClient(
      url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'),
      key,
      secret,
    );
    await client.updateParticipant(room, identity, undefined, {
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    });
  }
}
