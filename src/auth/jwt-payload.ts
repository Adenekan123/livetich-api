import { Role } from '@prisma/client';

/** Claims embedded in every access token — and later in LiveKit tokens. */
export interface JwtPayload {
  sub: string; // user id
  role: Role;
  name: string;
  email: string;
}
