import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Submit by pinning an exact commit in the student's own workspace.
 *
 * The SHA is a claim from the editor, and is resolved against GitHub before an
 * attempt is recorded (§44) — a client could otherwise name any string, or a
 * commit in someone else's repository.
 */
export class SubmitCommitDto {
  /** Full 40-character commit SHA. Abbreviated hashes are refused: an attempt
   *  has to name exactly one commit, for the rest of time. */
  @IsString()
  @Matches(/^[0-9a-f]{40}$/i, {
    message: 'That is not a full commit SHA',
  })
  commitSha!: string;

  /** Optional note the student attached when submitting. */
  @IsOptional()
  @IsString()
  note?: string;
}
