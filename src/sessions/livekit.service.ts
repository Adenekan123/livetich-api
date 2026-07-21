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
   * Join token for a room. Students join subscribe-only; publish rights for
   * screen share are granted later via participant-permission updates.
   */
  async mintJoinToken(opts: {
    room: string;
    userId: string;
    name: string;
    role: Role;
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
      canPublish: opts.role === Role.INSTRUCTOR,
      canSubscribe: true,
      canPublishData: true,
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
