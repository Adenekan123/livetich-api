import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Connect the signed-in student's GitHub account.
 *
 * The editor obtains this token from VS Code's own GitHub authentication and
 * sends it once. The server uses it only to ask GitHub who it belongs to, and
 * then throws it away — it is never stored, never logged, and never used to
 * act on the student's behalf (§9, §44).
 */
export class ConnectGitHubIdentityDto {
  /** A GitHub user access token. Bounded so an absurd body is refused early. */
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  token!: string;
}
