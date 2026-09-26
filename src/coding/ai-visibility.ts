/**
 * What a student may see of an AI review.
 *
 * `showAiToStudents` is off by default: the instructor sees the machine's
 * opinion first and decides whether it is fit to pass on. Until they do, a
 * student must not see it — and that means more than hiding the prose. The
 * provisional score *is* the AI's verdict expressed as a number, and the
 * per-requirement PASS/PARTIAL/FAIL marks are its reasoning; showing either
 * while claiming the notes are withheld would be a distinction without a
 * difference.
 *
 * What is never hidden by this: the instructor's own final score, their
 * decision, and any feedback they wrote. Those are theirs, and they travel by
 * their own rules (`visibleToStudent` on each feedback row).
 *
 * Pure, so the rule can be tested on its own rather than only through four
 * different read paths.
 */

/** The parts of a submission that carry AI output. */
export interface AiRedactable {
  /** The AI's score, before any instructor decision. */
  provisionalScore?: number | null;
  /** Review rows, each carrying a summary, findings and requirement verdicts. */
  reviews?: unknown[];
}

/**
 * Strip AI output from one submission.
 *
 * Returns a copy: the caller usually holds a Prisma row that is also used to
 * build something else, and mutating it in place has bitten this codebase
 * before.
 */
export function withoutAi<T extends AiRedactable>(submission: T): T {
  return {
    ...submission,
    provisionalScore: null,
    ...(submission.reviews === undefined ? {} : { reviews: [] }),
  };
}

/**
 * Apply the assignment's setting to a submission the student is reading.
 *
 * `isOwner` matters: an instructor or admin reading the same row always sees
 * everything, because the whole point of the flag is that they see it first.
 */
export function forStudent<T extends AiRedactable>(
  submission: T,
  showAiToStudents: boolean,
  isOwner: boolean,
): T {
  if (!isOwner || showAiToStudents) return submission;
  return withoutAi(submission);
}

/**
 * The score a student may see on a shared board.
 *
 * A live points board shows the room how everyone is doing, which is a
 * deliberate feature — but a provisional score is the AI's opinion, and
 * broadcasting it to the whole class while it is withheld from the student it
 * describes would be the same leak, louder. With the flag off, only a score
 * the instructor has actually decided is shown.
 */
export function boardScore(
  finalScore: number | null,
  provisionalScore: number | null,
  showAiToStudents: boolean,
): number | null {
  if (finalScore !== null) return finalScore;
  return showAiToStudents ? provisionalScore : null;
}
