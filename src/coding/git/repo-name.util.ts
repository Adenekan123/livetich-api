/**
 * Naming for a coding student's private repository.
 *
 * The name comes from the enrolment, never from the student. Student names are
 * not unique — five people called Muhammad in one cohort is ordinary — they are
 * not stable, and putting them in an infrastructure identifier leaks who owns
 * what to anyone who can list the organisation's repositories.
 *
 * So a name is built from three things that are each stable and together
 * identify exactly one person's place in exactly one program:
 *
 *     {programCode}-{cohortCode}-enr{enrolmentNo}   ->   fe-sep26-enr1042
 *
 * Nothing user-facing should show this. Livetich displays "Aisha Bello ·
 * Frontend Development · September 2026"; the repository name is plumbing.
 */

/** GitHub rejects anything longer; in practice these names are ~20 chars. */
export const MAX_REPO_NAME = 100;

/** Raised when a name cannot be built. Provisioning must fail loudly rather
 *  than invent a name, because a wrong name is a wrong repository forever. */
export class RepoNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoNameError';
  }
}

/**
 * Normalise one part to something GitHub accepts: lowercase, digits and
 * letters, single dashes, no leading or trailing dash.
 *
 * GitHub also allows `_` and `.`, but a repository named `.` or `..` is
 * invalid and a leading dot hides it in listings, so this keeps to the safe
 * subset rather than passing those through.
 */
export function slugPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export interface RepoNameParts {
  /** The program's short code, e.g. "FE". */
  programCode: string | null | undefined;
  /** The cohort/batch's short code, e.g. "SEP26". */
  cohortCode: string | null | undefined;
  /** The per-course enrolment number, e.g. 1042. */
  enrollmentNo: number | null | undefined;
}

/**
 * Build the repository name for one enrolment.
 *
 * Deterministic: the same enrolment always produces the same name, which is
 * what lets provisioning be retried safely — a second attempt looks for the
 * name it would have created and finds the repository already there, instead
 * of creating `fe-sep26-enr1042-2` (§39).
 */
export function repositoryName(parts: RepoNameParts): string {
  const program = slugPart(parts.programCode ?? '');
  const cohort = slugPart(parts.cohortCode ?? '');
  const no = parts.enrollmentNo;

  if (!program) {
    throw new RepoNameError(
      'The program needs a short code before a student can start coding',
    );
  }
  if (!cohort) {
    throw new RepoNameError(
      'This cohort needs a short code before a student can start coding',
    );
  }
  if (no == null || !Number.isInteger(no) || no <= 0) {
    throw new RepoNameError('This enrolment has no number yet');
  }

  const name = `${program}-${cohort}-enr${no}`;
  if (name.length > MAX_REPO_NAME) {
    throw new RepoNameError(
      `Repository name "${name}" is longer than GitHub allows — shorten the program or cohort code`,
    );
  }
  return name;
}

/**
 * Name for a competition repository (§36), kept in a separate namespace so an
 * official competition is never mixed into the student's course repository.
 */
export function competitionRepositoryName(parts: {
  competitionCode: string | null | undefined;
  enrollmentNo: number | null | undefined;
}): string {
  const code = slugPart(parts.competitionCode ?? '');
  const no = parts.enrollmentNo;
  if (!code) throw new RepoNameError('The competition needs a short code');
  if (no == null || !Number.isInteger(no) || no <= 0) {
    throw new RepoNameError('This entrant has no number yet');
  }
  const name = `cmp-${code}-enr${no}`;
  if (name.length > MAX_REPO_NAME) {
    throw new RepoNameError(
      `Repository name "${name}" is longer than GitHub allows`,
    );
  }
  return name;
}
