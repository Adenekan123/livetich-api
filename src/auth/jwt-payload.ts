import { Role } from '@prisma/client';

/** Claims embedded in every access token — and later in LiveKit tokens. */
export interface JwtPayload {
  sub: string; // user id
  role: Role;
  name: string;
  email: string;
  organizationId: string | null; // tenant the user belongs to
  emailVerified: boolean; // reissued on verify so it stays fresh in the token
  isSuperAdmin: boolean; // platform operator; gates /admin (guard re-checks the DB)
  /**
   * Present only on a recorder token: the short-lived credential handed to
   * LiveKit's headless browser so it can watch one session and film it.
   *
   * It carries the instructor's own identity — so a disabled account still
   * ends it, and the board sees an owner rather than a synthetic principal —
   * but this claim strips it back to exactly that: HTTP rejects it everywhere
   * except the one route that opts in, and the sockets refuse every write and
   * every session but this one.
   */
  recorder?: { sessionId: string; recordingId: string };
}
