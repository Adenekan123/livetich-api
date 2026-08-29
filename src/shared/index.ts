// Realtime contract between livetich-api and livetich-web.
// KEEP IN SYNC with livetich-web/src/lib/realtime-contract.ts

// ---------- Domain ----------

export type Role = 'INSTRUCTOR' | 'STUDENT' | 'ORG_ADMIN';

export type SessionStatus = 'SCHEDULED' | 'LIVE' | 'ENDED';

/** Which surface the class is looking at. The instructor drives it for everyone. */
export type StageView = 'video' | 'board' | 'quran' | 'code';

/** The room's colour scheme. Instructor-driven and shared by everyone in the
 *  session. 'teal' is the classic default; the rest re-tint the room chrome. */
export type RoomScheme = 'teal' | 'forest' | 'indigo' | 'plum';
export const ROOM_SCHEMES: readonly RoomScheme[] = [
  'teal',
  'forest',
  'indigo',
  'plum',
];

/** The verse the shared mushaf is turned to (instructor-driven). */
export interface QuranPosition {
  /** 1-based surah number (1–114). */
  surah: number;
  /** 1-based ayah to anchor/highlight; the whole surah is shown around it. */
  ayah: number;
}

export type PointsReason =
  | 'QUIZ_CORRECT'
  | 'BUZZER_WIN'
  | 'PARTICIPATION';

/** Buzzer round lifecycle (server-authoritative, see quiz module). */
export type BuzzerPhase =
  | 'IDLE'
  | 'COLLECTING'
  | 'QUESTION_OPEN'
  | 'WINNER'
  | 'TIMEOUT'
  | 'QA';

// ---------- Payloads ----------

export interface RoomUser {
  userId: string;
  name: string;
  role: Role;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  user: RoomUser;
  body: string;
  /** Same-origin URL of an attached voice note; null/absent for text. */
  audioUrl?: string | null;
  sentAt: string; // ISO, server clock
}

export interface LeaderboardEntry {
  userId: string;
  name: string;
  points: number;
  rank: number;
}

/** One student's standing on a live coding task. `score` is the instructor's
 *  final score if decided, else the AI provisional; null while still coding.
 *  Points fan out to everyone in the room — code never does. */
export interface CodingPointEntry {
  studentId: string;
  name: string;
  /** CodingSubmissionStatus, or 'CODING' when the student hasn't submitted. */
  status: string;
  score: number | null;
}

export interface QuizQuestionPublic {
  questionId: string;
  body: string;
  options: string[];
  timeLimitSec: number;
  /** Points the first correct answerer earns (instructor-set per question). */
  points: number;
  /** Server time the question opened; clients render a countdown against this. */
  openedAt: string;
}

export interface BuzzerState {
  phase: BuzzerPhase;
  eligibleUserIds: string[];
  question?: QuizQuestionPublic;
  winner?: RoomUser;
}

// ---------- Socket events ----------

export interface ClientToServerEvents {
  'room:join': (p: { sessionId: string; as?: 'teach' }) => void;
  'room:leave': (p: { sessionId: string }) => void;

  'chat:send': (p: { sessionId: string; body: string }) => void;
  /** Post a recorded voice note; audioUrl comes from the prior REST upload. */
  'chat:voice': (p: { sessionId: string; audioUrl: string }) => void;

  'hand:raise': (p: { sessionId: string }) => void;
  'hand:lower': (p: { sessionId: string }) => void;

  /** Student answers an open quiz/buzzer question. Server timestamps receipt. */
  'quiz:answer': (p: {
    sessionId: string;
    questionId: string;
    answerIndex: number;
  }) => void;

  // Instructor-only (server validates role)
  'chat:lock': (p: { sessionId: string; locked: boolean }) => void;
  'buzzer:start': (p: { sessionId: string; questionId: string }) => void;
  'student:pick-random': (p: { sessionId: string }) => void;
  'screen-share:grant': (p: { sessionId: string; userId: string }) => void;
  'screen-share:revoke': (p: { sessionId: string; userId: string }) => void;
  /** Instructor grants / revokes a specific student the mic. Students are muted
   *  by default and cannot unmute until granted (or picked to speak). */
  'mic:grant': (p: { sessionId: string; userId: string }) => void;
  'mic:revoke': (p: { sessionId: string; userId: string }) => void;
  /** Instructor switches the class between video, chalkboard, and mushaf. */
  'view:change': (p: { sessionId: string; view: StageView }) => void;
  /** Instructor sets the room's shared colour scheme for everyone. */
  'theme:change': (p: { sessionId: string; scheme: RoomScheme }) => void;
  /** Instructor turns the shared mushaf to a surah/ayah for everyone. */
  'quran:navigate': (p: {
    sessionId: string;
    surah: number;
    ayah: number;
  }) => void;
}

export interface ServerToClientEvents {
  'room:presence': (p: { sessionId: string; users: RoomUser[] }) => void;

  'chat:message': (p: ChatMessage) => void;
  /** Recent messages, sent once to the joining client. */
  'chat:history': (p: { sessionId: string; messages: ChatMessage[] }) => void;
  'chat:locked': (p: { sessionId: string; locked: boolean }) => void;

  'hands:update': (p: { sessionId: string; raised: RoomUser[] }) => void;

  /** The active surface, driven by the instructor; students follow. */
  'view:changed': (p: { sessionId: string; view: StageView }) => void;
  /** The room's current colour scheme; sent on join and on every change. */
  'theme:changed': (p: { sessionId: string; scheme: RoomScheme }) => void;

  /** Where the shared mushaf is turned; students follow the instructor. */
  'quran:position': (p: {
    sessionId: string;
    surah: number;
    ayah: number;
  }) => void;

  'leaderboard:update': (p: {
    sessionId: string;
    entries: LeaderboardEntry[];
  }) => void;

  /** A student just submitted coursework tied to this session — pushed to the
   *  instructor's staff room so the live grading panel updates in real time. */
  'submission:new': (p: {
    sessionId: string;
    submissionId: string;
    assignmentId: string;
    assignmentTitle: string;
    studentId: string;
    studentName: string;
    language: string | null;
    submittedAt: string;
  }) => void;

  /** A coding task went (or is) live in this session — students get a prompt to
   *  open it in their editor; everyone sees the points board start tracking. */
  'coding:task': (p: {
    sessionId: string;
    assignmentId: string;
    title: string;
    language: string | null;
    requirementCount: number;
    /** Deadline for a timed live task (ISO), or null if untimed. */
    dueAt: string | null;
  }) => void;

  /** Live per-student standings for a session's coding task (scores only, no
   *  code). Recomputed and pushed on submit, on AI review, and on decision. */
  'coding:points': (p: {
    sessionId: string;
    assignmentId: string;
    entries: CodingPointEntry[];
  }) => void;

  /** A coding submission changed — pushed to the staff room so the instructor's
   *  in-session review card updates without leaking code to peers. */
  'coding:submission': (p: {
    sessionId: string;
    submissionId: string;
    assignmentId: string;
    studentId: string;
    studentName: string;
    attemptNumber: number;
    status: string;
    provisionalScore: number | null;
    finalScore: number | null;
    aiConfidence: string | null;
  }) => void;

  'quiz:opened': (p: { sessionId: string; question: QuizQuestionPublic }) => void;
  'quiz:closed': (p: { sessionId: string; questionId: string }) => void;

  'buzzer:state': (p: { sessionId: string; state: BuzzerState }) => void;

  /** Personal result of a quiz/buzzer answer (sent only to the answerer). */
  'quiz:answer-result': (p: {
    questionId: string;
    isCorrect: boolean;
  }) => void;

  'student:picked': (p: { sessionId: string; user: RoomUser }) => void;

  'screen-share:granted': (p: { sessionId: string; userId: string }) => void;
  'screen-share:revoked': (p: { sessionId: string; userId: string }) => void;

  /** The set of students currently allowed to speak (mic granted by the
   *  instructor). Everyone else is mic-muted and cannot unmute. */
  'mic:speakers': (p: { sessionId: string; userIds: string[] }) => void;

  error: (p: { code: string; message: string }) => void;
}

// ---------- Chalkboard (Yjs, separate /board namespace) ----------

/** Yjs binary payload — Buffer on the server, ArrayBuffer in the browser. */
export type BoardBinary = ArrayBuffer | Uint8Array;

/** Presenter tools: the instructor's live camera + pointer (page coords), for
 *  follow-the-view and the shared laser. Ephemeral; cursor null = off-canvas. */
export interface BoardPresenter {
  sessionId: string;
  camera: { x: number; y: number; z: number };
  cursor: { x: number; y: number } | null;
  /** The presenter's current page id, so followers flip pages together. */
  page?: string;
  /** The presenter's visible page rectangle (page coords). Followers fit this to
   *  their own viewport so shared content stays legible on any screen size.
   *  Optional for back-compat with older presenters. */
  bounds?: { x: number; y: number; w: number; h: number };
}

export interface BoardClientToServerEvents {
  'board:join': (p: { sessionId: string; as?: 'teach' }) => void;
  'board:leave': (p: { sessionId: string }) => void;
  /** Instructor-only: incremental Yjs document update. */
  'board:update': (p: { sessionId: string; update: BoardBinary }) => void;
  /** Cursor/selection presence — relayed to the room, never persisted. */
  'board:awareness': (p: { sessionId: string; update: BoardBinary }) => void;
  /** Instructor-only: live camera + pointer for presenter tools. */
  'board:presenter': (p: BoardPresenter) => void;
  /** Instructor-only: open/close the board for student drawing. */
  'board:writable': (p: { sessionId: string; open: boolean }) => void;
}

export interface BoardServerToClientEvents {
  /** Full document state, sent to the joining client after board:join. */
  'board:state': (p: { sessionId: string; update: BoardBinary }) => void;
  'board:update': (p: { sessionId: string; update: BoardBinary }) => void;
  'board:awareness': (p: { sessionId: string; update: BoardBinary }) => void;
  'board:presenter': (p: BoardPresenter) => void;
  'board:writable': (p: { sessionId: string; open: boolean }) => void;

  error: (p: { code: string; message: string }) => void;
}

/**
 * Shared code editor (Code Instruction pack) — its own `/code` namespace, same
 * Yjs-over-socket shape as the chalkboard: a Y.Text (the buffer) plus a Y.Map
 * holding the language, so both persist and replay in one doc. Instructor
 * writes; students follow read-only.
 */
export interface CodeClientToServerEvents {
  'code:join': (p: { sessionId: string }) => void;
  'code:leave': (p: { sessionId: string }) => void;
  /** Instructor-only: incremental Yjs document update. */
  'code:update': (p: { sessionId: string; update: BoardBinary }) => void;
  /** Cursor/selection presence — relayed to the room, never persisted. */
  'code:awareness': (p: { sessionId: string; update: BoardBinary }) => void;
}

export interface CodeServerToClientEvents {
  /** Full document state, sent to the joining client after code:join. */
  'code:state': (p: { sessionId: string; update: BoardBinary }) => void;
  'code:update': (p: { sessionId: string; update: BoardBinary }) => void;
  'code:awareness': (p: { sessionId: string; update: BoardBinary }) => void;

  error: (p: { code: string; message: string }) => void;
}
