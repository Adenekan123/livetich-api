import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Finish connecting a GitHub organisation.
 *
 * The only thing the browser supplies is the installation id GitHub redirected
 * it back with. It is treated as a claim, not a fact: the server resolves it
 * with GitHub before anything is stored.
 */
export class ConnectGitHubDto {
  /** GitHub's numeric installation id, as a string. */
  @IsString()
  @Matches(/^\d{1,20}$/, {
    message: 'That does not look like a GitHub installation',
  })
  installationId!: string;
}

/**
 * Configure how one coding program provisions student repositories.
 *
 * Both fields are optional: a program with no template gets an empty private
 * repository with a first commit, which is a perfectly good starting point.
 */
export class ConfigureProgramGitDto {
  /**
   * A template repository in the same organisation, by name only — the owner is
   * always the connected organisation, so a program cannot be pointed at a
   * repository belonging to somebody else.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'Use just the repository name, not its full URL',
  })
  templateRepositoryName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  // No escape on the slash: inside a character class it is already literal,
  // and branch names legitimately contain one (feature/login).
  @Matches(/^[A-Za-z0-9._/-]+$/, {
    message: 'That is not a valid branch name',
  })
  defaultBranch?: string;
}
