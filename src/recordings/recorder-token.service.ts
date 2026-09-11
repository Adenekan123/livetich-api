import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/jwt-payload';

/**
 * The credential LiveKit's headless browser uses to watch a class.
 *
 * Recording a *page* rather than a room means something has to log in as a
 * viewer, and that something is a browser we do not control, reached over a
 * URL. So the credential is scoped as narrowly as it can be and still work:
 * one session, read-only, and dead within the day.
 *
 * It names whoever pressed Record rather than a synthetic account on purpose:
 * the board already knows how to admit that person, and disabling their
 * account still kills the token at the guard. Not the course's instructor —
 * that field is nullable, and an admin-run course has none.
 */
@Injectable()
export class RecorderTokenService {
  /**
   * Long enough for a class that overruns, short enough that a leaked URL is
   * worthless by tomorrow. Egress is stopped explicitly anyway; this is only
   * the backstop.
   */
  private static readonly TTL = '12h';

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async mint(opts: {
    sessionId: string;
    recordingId: string;
    /** The user who started the recording; see the note above. */
    startedById: string;
  }): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: opts.startedById },
      select: {
        id: true,
        role: true,
        name: true,
        email: true,
        organizationId: true,
        emailVerified: true,
        isSuperAdmin: true,
      },
    });
    const payload: JwtPayload = {
      sub: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      organizationId: user.organizationId,
      emailVerified: user.emailVerified,
      // Never hand platform-operator reach to a browser on someone else's
      // infrastructure, whatever the instructor happens to be.
      isSuperAdmin: false,
      recorder: {
        sessionId: opts.sessionId,
        recordingId: opts.recordingId,
      },
    };
    return this.jwt.signAsync(payload, {
      expiresIn: RecorderTokenService.TTL,
    });
  }

  /** Verify a recorder token and insist it is for the session it claims. */
  verify(token: string, sessionId: string): JwtPayload {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired recorder token');
    }
    if (!payload.recorder || payload.recorder.sessionId !== sessionId) {
      throw new UnauthorizedException('This token is not for this session');
    }
    return payload;
  }
}
