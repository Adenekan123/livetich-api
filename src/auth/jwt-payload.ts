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
}
