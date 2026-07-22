// Realtime contract between livetich-api and livetich-web.
// KEEP IN SYNC with livetich-web/src/lib/realtime-contract.ts

// ---------- Domain ----------

export type Role = 'INSTRUCTOR' | 'STUDENT';

export type SessionStatus = 'SCHEDULED' | 'LIVE' | 'ENDED';

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
}

export interface ServerToClientEvents {
  'room:presence': (p: { sessionId: string; users: RoomUser[] }) => void;

  'chat:message': (p: ChatMessage) => void;
  /** Recent messages, sent once to the joining client. */
  'chat:history': (p: { sessionId: string; messages: ChatMessage[] }) => void;
  'chat:locked': (p: { sessionId: string; locked: boolean }) => void;

  'hands:update': (p: { sessionId: string; raised: RoomUser[] }) => void;

  'leaderboard:update': (p: {
    sessionId: string;
    entries: LeaderboardEntry[];
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

export interface BoardClientToServerEvents {
  'board:join': (p: { sessionId: string }) => void;
  'board:leave': (p: { sessionId: string }) => void;
  /** Instructor-only: incremental Yjs document update. */
  'board:update': (p: { sessionId: string; update: BoardBinary }) => void;
  /** Cursor/selection presence — relayed to the room, never persisted. */
  'board:awareness': (p: { sessionId: string; update: BoardBinary }) => void;
}

export interface BoardServerToClientEvents {
  /** Full document state, sent to the joining client after board:join. */
  'board:state': (p: { sessionId: string; update: BoardBinary }) => void;
  'board:update': (p: { sessionId: string; update: BoardBinary }) => void;
  'board:awareness': (p: { sessionId: string; update: BoardBinary }) => void;

  error: (p: { code: string; message: string }) => void;
}
