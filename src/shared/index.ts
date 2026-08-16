// Realtime contract between livetich-api and livetich-web.
// KEEP IN SYNC with livetich-web/src/lib/realtime-contract.ts

// ---------- Domain ----------

export type Role = 'INSTRUCTOR' | 'STUDENT' | 'ORG_ADMIN';

export type SessionStatus = 'SCHEDULED' | 'LIVE' | 'ENDED';

/** Which surface the class is looking at. The instructor drives it for everyone. */
export type StageView = 'video' | 'board' | 'quran' | 'code';

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
  sentAt: string; // ISO, server clock
}

export interface LeaderboardEntry {
  userId: string;
  name: string;
  points: number;
  rank: number;
}

export interface QuizQuestionPublic {
  questionId: string;
  body: string;
  options: string[];
  timeLimitSec: number;
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
  'room:join': (p: { sessionId: string }) => void;
  'room:leave': (p: { sessionId: string }) => void;

  'chat:send': (p: { sessionId: string; body: string }) => void;

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
  /** Instructor switches the class between video, chalkboard, and mushaf. */
  'view:change': (p: { sessionId: string; view: StageView }) => void;
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
}

export interface BoardClientToServerEvents {
  'board:join': (p: { sessionId: string }) => void;
  'board:leave': (p: { sessionId: string }) => void;
  /** Instructor-only: incremental Yjs document update. */
  'board:update': (p: { sessionId: string; update: BoardBinary }) => void;
  /** Cursor/selection presence — relayed to the room, never persisted. */
  'board:awareness': (p: { sessionId: string; update: BoardBinary }) => void;
  /** Instructor-only: live camera + pointer for presenter tools. */
  'board:presenter': (p: BoardPresenter) => void;
}

export interface BoardServerToClientEvents {
  /** Full document state, sent to the joining client after board:join. */
  'board:state': (p: { sessionId: string; update: BoardBinary }) => void;
  'board:update': (p: { sessionId: string; update: BoardBinary }) => void;
  'board:awareness': (p: { sessionId: string; update: BoardBinary }) => void;
  'board:presenter': (p: BoardPresenter) => void;

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
