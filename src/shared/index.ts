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

// ---------- Tajweed (Islamic Education pack) ----------

/**
 * The Tajweed rules an annotation can carry, in the groups a teacher thinks in.
 *
 * Data, not buttons: the picker is built from this, so adding a rule is one
 * entry here. A rule is addressed as "group.rule" — nun.ikhfa_haqiqi. The
 * Arabic name is part of the rule, because the teacher names it in Arabic to
 * the class and the student's screen shows both. Colours are not here: Tajweed
 * mushafs do not agree on one scheme, so the web holds suggestions per group
 * and the teacher can change them.
 *
 * Riwayah of Hafs 'an 'Asim, drafted for an instructor to confirm.
 */
export const TAJWEED_RULE_GROUPS = [
  {
    key: 'nun',
    label: 'Noon sakinah & tanween',
    arabic: 'النون الساكنة والتنوين',
    rules: [
      { key: 'izhar_halqi', label: 'Izhar halqi', arabic: 'إظهار حلقي' },
      {
        key: 'idgham_ghunnah',
        label: 'Idgham with ghunnah',
        arabic: 'إدغام بغنة',
      },
      {
        key: 'idgham_no_ghunnah',
        label: 'Idgham without ghunnah',
        arabic: 'إدغام بلا غنة',
      },
      { key: 'iqlab', label: 'Iqlab', arabic: 'إقلاب' },
      { key: 'ikhfa_haqiqi', label: 'Ikhfa haqiqi', arabic: 'إخفاء حقيقي' },
    ],
  },
  {
    key: 'mim',
    label: 'Meem sakinah',
    arabic: 'الميم الساكنة',
    rules: [
      { key: 'ikhfa_shafawi', label: 'Ikhfa shafawi', arabic: 'إخفاء شفوي' },
      { key: 'idgham_shafawi', label: 'Idgham shafawi', arabic: 'إدغام شفوي' },
      { key: 'izhar_shafawi', label: 'Izhar shafawi', arabic: 'إظهار شفوي' },
    ],
  },
  {
    key: 'ghunnah',
    label: 'Ghunnah',
    arabic: 'الغنة',
    rules: [
      {
        key: 'mushaddadah',
        label: 'Noon or meem with shaddah',
        arabic: 'غنة النون والميم المشددتين',
      },
    ],
  },
  {
    key: 'qalqalah',
    label: 'Qalqalah',
    arabic: 'القلقلة',
    rules: [
      { key: 'sughra', label: 'Qalqalah sughra', arabic: 'قلقلة صغرى' },
      { key: 'kubra', label: 'Qalqalah kubra', arabic: 'قلقلة كبرى' },
    ],
  },
  {
    key: 'madd',
    label: 'Madd',
    arabic: 'المد',
    rules: [
      { key: 'tabii', label: 'Madd tabi‘i', arabic: 'مد طبيعي' },
      { key: 'muttasil', label: 'Madd muttasil', arabic: 'مد متصل' },
      { key: 'munfasil', label: 'Madd munfasil', arabic: 'مد منفصل' },
      { key: 'arid', label: 'Madd ‘arid lis-sukun', arabic: 'مد عارض للسكون' },
      { key: 'lin', label: 'Madd lin', arabic: 'مد اللين' },
      { key: 'badal', label: 'Madd badal', arabic: 'مد البدل' },
      { key: 'iwad', label: 'Madd ‘iwad', arabic: 'مد العوض' },
      {
        key: 'silah_sughra',
        label: 'Madd silah sughra',
        arabic: 'مد الصلة الصغرى',
      },
      {
        key: 'silah_kubra',
        label: 'Madd silah kubra',
        arabic: 'مد الصلة الكبرى',
      },
      {
        key: 'lazim_kalimi_muthaqqal',
        label: 'Madd lazim kalimi muthaqqal',
        arabic: 'مد لازم كلمي مثقل',
      },
      {
        key: 'lazim_kalimi_mukhaffaf',
        label: 'Madd lazim kalimi mukhaffaf',
        arabic: 'مد لازم كلمي مخفف',
      },
      {
        key: 'lazim_harfi_muthaqqal',
        label: 'Madd lazim harfi muthaqqal',
        arabic: 'مد لازم حرفي مثقل',
      },
      {
        key: 'lazim_harfi_mukhaffaf',
        label: 'Madd lazim harfi mukhaffaf',
        arabic: 'مد لازم حرفي مخفف',
      },
      { key: 'tamkin', label: 'Madd tamkin', arabic: 'مد التمكين' },
      { key: 'farq', label: 'Madd farq', arabic: 'مد الفرق' },
    ],
  },
  {
    key: 'idgham',
    label: 'Idgham of letters',
    arabic: 'إدغام الحروف',
    rules: [
      {
        key: 'mutamathilayn',
        label: 'Mutamathilayn',
        arabic: 'إدغام المتماثلين',
      },
      {
        key: 'mutajanisayn',
        label: 'Mutajanisayn',
        arabic: 'إدغام المتجانسين',
      },
      {
        key: 'mutaqaribayn',
        label: 'Mutaqaribayn',
        arabic: 'إدغام المتقاربين',
      },
    ],
  },
  {
    key: 'lam',
    label: 'Lam',
    arabic: 'اللام',
    rules: [
      { key: 'shamsiyyah', label: 'Lam shamsiyyah', arabic: 'اللام الشمسية' },
      { key: 'qamariyyah', label: 'Lam qamariyyah', arabic: 'اللام القمرية' },
      {
        key: 'jalalah_tafkhim',
        label: 'Lam of Allah, heavy',
        arabic: 'تفخيم لام لفظ الجلالة',
      },
      {
        key: 'jalalah_tarqiq',
        label: 'Lam of Allah, light',
        arabic: 'ترقيق لام لفظ الجلالة',
      },
    ],
  },
  {
    key: 'ra',
    label: 'Ra',
    arabic: 'الراء',
    rules: [
      { key: 'tafkhim', label: 'Ra heavy (tafkhim)', arabic: 'تفخيم الراء' },
      { key: 'tarqiq', label: 'Ra light (tarqiq)', arabic: 'ترقيق الراء' },
    ],
  },
  {
    key: 'sifat',
    label: 'Heavy & light letters',
    arabic: 'التفخيم والترقيق',
    rules: [
      {
        key: 'istila',
        label: 'Heavy letter (isti‘la)',
        arabic: 'حروف الاستعلاء',
      },
      {
        key: 'istifal',
        label: 'Light letter (istifal)',
        arabic: 'حروف الاستفال',
      },
    ],
  },
  {
    key: 'hamzah',
    label: 'Hamzah',
    arabic: 'الهمزة',
    rules: [
      { key: 'wasl', label: 'Hamzat al-wasl', arabic: 'همزة الوصل' },
      { key: 'qat', label: 'Hamzat al-qat‘', arabic: 'همزة القطع' },
    ],
  },
  {
    key: 'waqf',
    label: 'Stopping & starting',
    arabic: 'الوقف والابتداء',
    rules: [
      { key: 'lazim', label: 'Must stop (lazim)', arabic: 'الوقف اللازم' },
      { key: 'mamnu', label: 'Do not stop', arabic: 'الوقف الممنوع' },
      { key: 'jaiz', label: 'Stopping allowed (jaiz)', arabic: 'الوقف الجائز' },
      { key: 'wasl_awla', label: 'Joining preferred', arabic: 'الوصل أولى' },
      { key: 'waqf_awla', label: 'Stopping preferred', arabic: 'الوقف أولى' },
      {
        key: 'muanaqah',
        label: 'Stop at one of two (mu‘anaqah)',
        arabic: 'وقف المعانقة',
      },
      { key: 'saktah', label: 'Saktah', arabic: 'السكتة' },
    ],
  },
] as const;

export type TajweedRuleGroupKey = (typeof TAJWEED_RULE_GROUPS)[number]['key'];

/** Every "group.rule" in the taxonomy, as a type. */
type RuleIdsOf<G> = G extends {
  key: infer K extends string;
  rules: readonly { key: infer R extends string }[];
}
  ? `${K}.${R}`
  : never;
export type TajweedRuleId = RuleIdsOf<(typeof TAJWEED_RULE_GROUPS)[number]>;

/**
 * Rule keys from before the taxonomy was grouped.
 *
 * Still accepted, so annotations already saved keep working, and deliberately
 * kept out of the picker: "madd" named a group rather than a rule, and deciding
 * for a teacher which madd they meant would rewrite their record.
 */
export const TAJWEED_LEGACY_RULES = [
  'madd',
  'ghunnah',
  'ikhfa',
  'idgham',
  'iqlab',
  'izhar',
  'qalqalah',
  'waqf',
] as const;
export type TajweedLegacyRule = (typeof TAJWEED_LEGACY_RULES)[number];

export type TajweedRule = TajweedRuleId | TajweedLegacyRule | 'custom';

export interface TajweedRuleInfo {
  label: string;
  /** The rule's name in Arabic, where it has one. */
  arabic: string | null;
  group: TajweedRuleGroupKey | null;
  groupLabel: string | null;
  /** Offered in the picker. Legacy keys are not. */
  pickable: boolean;
}

const LEGACY_LABELS: Record<TajweedLegacyRule, string> = {
  madd: 'Madd',
  ghunnah: 'Ghunnah',
  ikhfa: 'Ikhfa',
  idgham: 'Idgham',
  iqlab: 'Iqlab',
  izhar: 'Izhar',
  qalqalah: 'Qalqalah',
  waqf: 'Waqf',
};

/** Every rule the API accepts, by key. */
export const TAJWEED_RULES: Record<TajweedRule, TajweedRuleInfo> = (() => {
  const out = {} as Record<TajweedRule, TajweedRuleInfo>;
  for (const group of TAJWEED_RULE_GROUPS) {
    for (const rule of group.rules) {
      out[`${group.key}.${rule.key}` as TajweedRule] = {
        label: rule.label,
        arabic: rule.arabic,
        group: group.key,
        groupLabel: group.label,
        pickable: true,
      };
    }
  }
  out.custom = {
    label: 'Custom note',
    arabic: null,
    group: null,
    groupLabel: null,
    pickable: true,
  };
  for (const key of TAJWEED_LEGACY_RULES) {
    out[key] = {
      label: LEGACY_LABELS[key],
      arabic: null,
      group: null,
      groupLabel: null,
      pickable: false,
    };
  }
  return out;
})();

/** Accepted on the way in — legacy keys included. */
export const TAJWEED_RULE_KEYS = Object.keys(TAJWEED_RULES) as TajweedRule[];

/** Offered to a teacher, in taxonomy order. */
export const TAJWEED_PICKABLE_RULE_KEYS = TAJWEED_RULE_KEYS.filter(
  (key) => TAJWEED_RULES[key].pickable,
);
export type TajweedAnnotationStyle = 'HIGHLIGHT' | 'UNDERLINE';
export type TajweedAnnotationMode = 'LESSON' | 'STUDENT_CORRECTION';
export type TajweedOutcome =
  | 'CORRECT'
  | 'REPEAT'
  | 'TAJWEED_ISSUE'
  | 'PRONUNCIATION'
  | 'NOTE';

/**
 * One piece of the text a mark holds: a whole ayah, one word of it, or one
 * letter of that word.
 *
 * Positions are 0-based, and a letter is a grapheme cluster — never a string
 * index, or the harakat would be cut off their letter.
 */
export interface TajweedPart {
  surahNumber: number;
  ayahNumber: number;
  /** Null marks the whole ayah. */
  wordIndex: number | null;
  /** Null marks the whole word. */
  letterIndex: number | null;
}

/**
 * Where a mark points: the parts it holds, which may sit in different ayahs —
 * a rule can live on the last letter of one ayah and the first of the next.
 *
 * Nothing between two parts is implied. The mark holds exactly what the teacher
 * picked, so a noon in one word and a sheen two words later are those two
 * letters and nothing in between.
 */
export interface TajweedRef {
  /** The first part's ayah, denormalised: what the mark is filed under and
   *  ordered by. Never trust it for drawing — use the parts. */
  surahNumber: number;
  ayahNumber: number;
  parts: TajweedPart[];
}

/** A saved annotation, as the API returns it and the room broadcasts it. */
export interface TajweedAnnotation extends TajweedRef {
  id: string;
  courseId: string;
  sectionId: string | null;
  sessionId: string | null;
  mode: TajweedAnnotationMode;
  studentId: string | null;
  hifzEntryId: string | null;
  /** Kept for next time: shown to any class in this course that opens these
   *  ayahs, instead of only the lesson it was made in. */
  kept: boolean;
  rule: TajweedRule | null;
  customLabel: string | null;
  style: TajweedAnnotationStyle;
  color: string | null;
  note: string | null;
  outcome: TajweedOutcome | null;
  version: number;
  createdById: string;
  updatedById: string;
  createdAt: string;
  updatedAt: string;
}

/** A live annotation: shown to the room while teaching and never stored in the
 *  database. "Save to lesson" turns it into a TajweedAnnotation over HTTP. */
export interface TajweedTemporaryAnnotation extends TajweedRef {
  id: string;
  rule: TajweedRule;
  customLabel: string | null;
  style: TajweedAnnotationStyle;
  color: string | null;
  note: string | null;
  /** Server time it disappears (ISO), or null to stay until cleared. */
  expiresAt: string | null;
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
  /** Instructor shows (or replaces) a live Tajweed annotation for the room.
   *  ttlSec > 0 makes it disappear on its own (max one hour). */
  'tajweed:temporary:set': (p: {
    sessionId: string;
    annotation: Omit<TajweedTemporaryAnnotation, 'expiresAt'> & {
      ttlSec?: number;
    };
  }) => void;
  /** Instructor clears one live annotation, or all of them when id is absent. */
  'tajweed:temporary:clear': (p: { sessionId: string; id?: string }) => void;
  /**
   * What the instructor has picked, before any rule is chosen.
   *
   * The class sees the same letters outlined while the teacher decides, which
   * is what makes marking a shared act rather than a result. Nothing is stored:
   * it lasts as long as the pick does.
   */
  'tajweed:pointing:set': (p: {
    sessionId: string;
    parts: TajweedPart[];
  }) => void;
  'tajweed:pointing:clear': (p: { sessionId: string }) => void;
}

export interface ServerToClientEvents {
  'room:presence': (p: { sessionId: string; users: RoomUser[] }) => void;

  /** The instructor ended the class and the org evicts students on end — the
   *  student clients leave the room. Reason lets the UI phrase it. */
  'room:closed': (p: { sessionId: string; reason: 'ENDED' }) => void;

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

  /** A saved Tajweed annotation changed in this session. Lesson annotations go
   *  to the whole room; student corrections to staff only. */
  'tajweed:annotation:created': (p: {
    sessionId: string;
    annotation: TajweedAnnotation;
  }) => void;
  'tajweed:annotation:updated': (p: {
    sessionId: string;
    annotation: TajweedAnnotation;
  }) => void;
  'tajweed:annotation:deleted': (p: {
    sessionId: string;
    id: string;
    mode: TajweedAnnotationMode;
  }) => void;
  /** Every live annotation in the session — sent on join and on each change,
   *  so a client only ever replaces its list and never has to merge. */
  'tajweed:temporary': (p: {
    sessionId: string;
    annotations: TajweedTemporaryAnnotation[];
  }) => void;
  /** What the instructor is pointing at right now; empty when nothing is
   *  picked. Sent on join too, so a late arrival sees the same outline. */
  'tajweed:pointing': (p: { sessionId: string; parts: TajweedPart[] }) => void;

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
