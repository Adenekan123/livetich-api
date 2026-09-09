import { IsNotEmpty, IsString } from 'class-validator';

/** Body for POST /auth/join-workspace — join another org via its invite link,
 *  using the current (authenticated) account instead of creating a new one. */
export class JoinWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  inviteToken!: string;
}
