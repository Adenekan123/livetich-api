import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { PointsReason, Prisma, Role, SessionStatus, UserStatus } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import { AuthCacheService } from '../auth/auth-cache.service';
import type { JwtPayload } from '../auth/jwt-payload';
import { SkipThrottle } from '@nestjs/throttler';
import { PointsService, POINTS_BUZZER_WIN } from '../points/points.service';
import { PrismaService } from '../prisma/prisma.service';
import { LivekitService } from '../sessions/livekit.service';
import type {
  BuzzerState,
  ClientToServerEvents,
  QuizQuestionPublic,
  RoomScheme,
  RoomUser,
  ServerToClientEvents,
} from '../shared';
import { ROOM_SCHEMES } from '../shared';
import { RoomStateService } from './room-state.service';
import { RoomBroadcaster, staffRoom } from '../realtime/room-broadcaster';
import { PluginsService } from '../plugins/plugins.service';
import {
  PLUGIN_CODE_INSTRUCTION,
  PLUGIN_ISLAMIC_EDUCATION,
} from '../plugins/catalog';

interface SocketData {
  user: JwtPayload;
  sessionIds: Set<string>;
  /** Resolves once the account gate has run: true = permitted, false = rejected.
   *  room:join awaits this so a message racing the async check can't slip past. */
  authReady: Promise<boolean>;
  /** An org admin who joined in teach-mode (solo teacher): treated as the
   *  session's host for the life of this socket rather than a shadow observer. */
  teaching?: boolean;
}

type RoomServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  never,
  SocketData
>;
type RoomSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  never,
  SocketData
>;

// The global HTTP ThrottlerGuard reads `req.ip` off an undefined request on a
// socket message and would 500 it; sockets aren't rate-limited by the HTTP
// throttler (the gateway does its own auth/validation).
@SkipThrottle()
@WebSocketGateway({ cors: { origin: true } })
export class RoomGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RoomGateway.name);

  /**
   * Buzzer countdowns are in-process; with multiple gateway instances this
   * moves to a Redis-driven delayed job (BullMQ) so any instance can close
   * the question.
   */
  private readonly buzzerTimers = new Map<string, NodeJS.Timeout>();

  @WebSocketServer()
  server!: RoomServer;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly state: RoomStateService,
    private readonly points: PointsService,
    private readonly livekit: LivekitService,
    private readonly authCache: AuthCacheService,
    private readonly broadcaster: RoomBroadcaster,
    private readonly plugins: PluginsService,
  ) {}

  // Hand the socket server to the broadcaster so HTTP code can push into rooms.
  afterInit(server: RoomServer) {
    this.broadcaster.bind(server);
  }

  // ---------- Connection lifecycle ----------

  async handleConnection(client: RoomSocket) {
    // Kick off auth and stash the promise so message handlers (which can arrive
    // the instant the socket connects, before the async account check resolves)
    // can await the outcome instead of racing it. The `.catch` keeps a transient
    // failure from surfacing as an unhandled rejection and closes the socket.
    client.data.authReady = this.authenticate(client).catch(() => {
      client.disconnect(true);
      return false;
    });
    await client.data.authReady;
  }

  /**
   * Verify the socket's token and account state. The token is verified
   * synchronously so `client.data.user` is attached before the first await —
   * any handler then has an identity — while room:join additionally awaits
   * `authReady` so it can't act before the account gate (disabled/unverified)
   * has run. Emits an error and disconnects on failure.
   */
  private async authenticate(client: RoomSocket): Promise<boolean> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.split(' ')[1];
    let user: JwtPayload;
    try {
      user = this.jwt.verify<JwtPayload>(token ?? '');
    } catch {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return false;
    }
    client.data.user = user;
    client.data.sessionIds = new Set();

    // Same gate as the HTTP guard: disabled or unverified accounts can't hold a
    // live socket (the token is long-lived, so re-check against current state).
    const account = await this.authCache.getState(user.sub);
    if (!account || account.status === UserStatus.DISABLED || !account.emailVerified) {
      client.emit('error', { code: 'FORBIDDEN', message: 'Account not permitted' });
      client.disconnect(true);
      return false;
    }
    return true;
  }

  async handleDisconnect(client: RoomSocket) {
    const user = client.data.user;
    if (!user) return;
    for (const sessionId of client.data.sessionIds ?? []) {
      await this.state.removePresence(sessionId, user.sub);
      await this.state.lowerHand(sessionId, user.sub);
      await this.broadcastPresence(sessionId);
      await this.broadcastHands(sessionId);
    }
  }

  // ---------- Room membership ----------

  @SubscribeMessage('room:join')
  async onJoin(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; as?: 'teach' },
  ) {
    // Wait out the account gate before doing anything — otherwise a rejected
    // (disabled/unverified) socket could add presence in the brief window before
    // it's disconnected.
    if (!(await client.data.authReady)) return;
    const user = client.data.user;
    const session = await this.prisma.liveSession.findUnique({
      where: { id: p.sessionId },
      include: {
        course: {
          select: { id: true, instructorId: true, organizationId: true },
        },
      },
    });
    if (!session || session.status === SessionStatus.ENDED) {
      return this.fail(client, 'NOT_JOINABLE', 'Session not found or ended');
    }

    // Admins shadow-observe silently — unless they entered in teach-mode, where
    // a solo-teacher admin joins visibly as the session host. Everyone else must
    // own or be enrolled.
    const isAdmin = user.role === Role.ORG_ADMIN;
    const teaching = isAdmin && p.as === 'teach';
    const shadow = isAdmin && !teaching;
    client.data.teaching = teaching;
    if (user.role === Role.INSTRUCTOR) {
      if (session.course.instructorId !== user.sub) {
        return this.fail(client, 'FORBIDDEN', 'Not your session');
      }
    } else if (isAdmin) {
      if (session.course.organizationId !== user.organizationId) {
        return this.fail(client, 'FORBIDDEN', 'Not your organization');
      }
    } else {
      // Enrolled students may enter a scheduled (not-yet-live) session and wait
      // in the room — the client shows the "instructor will join soon" board,
      // keyed off instructor presence. Rejecting them here left early joiners
      // stuck: when the instructor later arrived, they were never re-admitted.
      const enrolled = await this.prisma.enrollment.findUnique({
        where: {
          courseId_studentId: {
            courseId: session.course.id,
            studentId: user.sub,
          },
        },
        select: { id: true },
      });
      if (!enrolled) return this.fail(client, 'FORBIDDEN', 'Not enrolled');
    }

    await client.join(p.sessionId);
    // Staff join a private sub-room for instructor-only pushes (e.g. incoming
    // submissions), so student PII never fans out to peer students.
    if (user.role !== Role.STUDENT) await client.join(staffRoom(p.sessionId));
    client.data.sessionIds.add(p.sessionId);
    if (shadow) {
      // Never enter presence — the whole point is that neither the instructor
      // nor the students can tell an admin is watching. Just send them the
      // current roster so their own view is populated.
      client.emit('room:presence', {
        sessionId: p.sessionId,
        users: await this.state.listPresence(p.sessionId),
      });
    } else {
      await this.state.addPresence(p.sessionId, this.roomUser(client));
      await this.broadcastPresence(p.sessionId);
    }
    // Late joiners still need current room state:
    client.emit('chat:locked', {
      sessionId: p.sessionId,
      locked: await this.state.isChatLocked(p.sessionId),
    });
    client.emit('view:changed', {
      sessionId: p.sessionId,
      view: await this.state.getView(p.sessionId),
    });
    client.emit('theme:changed', {
      sessionId: p.sessionId,
      scheme: await this.state.getTheme(p.sessionId),
    });
    // The shared mushaf is an Islamic Education pack surface — only seed/emit
    // its position for orgs that have the pack on. A plain classroom never
    // opens the reader (see the matching web + view:change gates).
    if (
      await this.plugins.isEnabled(
        session.course.organizationId,
        PLUGIN_ISLAMIC_EDUCATION,
      )
    ) {
      // Open the shared mushaf wherever the class last stopped reciting — seeded
      // once for a fresh room (SETNX-style), so it never overrides the
      // instructor's live page nor re-jumps on a reconnect.
      if (!(await this.state.hasQuranPos(p.sessionId))) {
        const anchor = await this.lastRecitationAnchor(session.course.id);
        if (anchor) await this.state.setQuranPos(p.sessionId, anchor);
      }
      const pos = await this.state.getQuranPos(p.sessionId);
      client.emit('quran:position', { sessionId: p.sessionId, ...pos });
    }
    await this.broadcastHands(p.sessionId, client);
    await this.broadcastSpeakers(p.sessionId, client);
    await this.sendChatHistory(p.sessionId, client);
  }

  /** Where the course last stopped reciting — the end ayah of its most recent
   *  Hifz entry — used to open a fresh session's mushaf at that spot. */
  private async lastRecitationAnchor(
    courseId: string,
  ): Promise<{ surah: number; ayah: number } | null> {
    const last = await this.prisma.hifzEntry.findFirst({
      where: { courseId },
      orderBy: { recordedAt: 'desc' },
      select: { surahNumber: true, ayahEnd: true },
    });
    return last ? { surah: last.surahNumber, ayah: last.ayahEnd } : null;
  }

  /** Last 50 messages so late joiners aren't dropped into a blank chat. */
  private async sendChatHistory(sessionId: string, client: RoomSocket) {
    const recent = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      include: { user: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    client.emit('chat:history', {
      sessionId,
      messages: recent.reverse().map((m) => ({
        id: m.id,
        sessionId,
        user: { userId: m.user.id, name: m.user.name, role: m.user.role },
        body: m.body,
        audioUrl: m.audioUrl,
        sentAt: m.createdAt.toISOString(),
      })),
    });
  }

  @SubscribeMessage('room:leave')
  async onLeave(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    const user = client.data.user;
    await client.leave(p.sessionId);
    client.data.sessionIds.delete(p.sessionId);
    await this.state.removePresence(p.sessionId, user.sub);
    await this.state.lowerHand(p.sessionId, user.sub);
    await this.broadcastPresence(p.sessionId);
    await this.broadcastHands(p.sessionId);
  }

  // ---------- Chat ----------

  @SubscribeMessage('chat:send')
  async onChat(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; body: string },
  ) {
    const user = client.data.user;
    if (!this.inRoom(client, p.sessionId)) return;
    const body = p.body?.trim();
    if (!body || body.length > 2000) return;

    if (
      this.actingRole(client) !== Role.INSTRUCTOR &&
      (await this.state.isChatLocked(p.sessionId))
    ) {
      return this.fail(client, 'CHAT_LOCKED', 'Chat is locked');
    }

    const saved = await this.prisma.chatMessage.create({
      data: { sessionId: p.sessionId, userId: user.sub, body },
    });
    this.server.to(p.sessionId).emit('chat:message', {
      id: saved.id,
      sessionId: p.sessionId,
      user: this.roomUser(client),
      body,
      sentAt: saved.createdAt.toISOString(),
    });
  }

  @SubscribeMessage('chat:voice')
  async onChatVoice(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; audioUrl: string },
  ) {
    const user = client.data.user;
    if (!this.inRoom(client, p.sessionId)) return;
    // Only accept URLs we minted (the /api/files/voice proxy path) so the chat
    // can't be used to inject arbitrary links dressed up as audio.
    const audioUrl = p.audioUrl?.trim();
    if (!audioUrl || !/^\/api\/files\/voice\/[\w-]+$/.test(audioUrl)) return;

    if (
      this.actingRole(client) !== Role.INSTRUCTOR &&
      (await this.state.isChatLocked(p.sessionId))
    ) {
      return this.fail(client, 'CHAT_LOCKED', 'Chat is locked');
    }

    const saved = await this.prisma.chatMessage.create({
      data: { sessionId: p.sessionId, userId: user.sub, body: '', audioUrl },
    });
    this.server.to(p.sessionId).emit('chat:message', {
      id: saved.id,
      sessionId: p.sessionId,
      user: this.roomUser(client),
      body: '',
      audioUrl,
      sentAt: saved.createdAt.toISOString(),
    });
  }

  @SubscribeMessage('chat:lock')
  async onChatLock(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; locked: boolean },
  ) {
    if (!(await this.isOwner(client, p.sessionId))) return;
    await this.state.setChatLock(p.sessionId, p.locked);
    this.server
      .to(p.sessionId)
      .emit('chat:locked', { sessionId: p.sessionId, locked: p.locked });
  }

  @SubscribeMessage('view:change')
  async onViewChange(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody()
    p: { sessionId: string; view: 'video' | 'board' | 'quran' | 'code' },
  ) {
    const session = await this.ownedSession(client, p.sessionId);
    if (!session) return;
    const view =
      p.view === 'board' || p.view === 'quran' || p.view === 'code'
        ? p.view
        : 'video';
    // Pack-gated stages: the mushaf needs Islamic Education, the shared code
    // editor needs Code Instruction. Reject rather than silently downgrade so a
    // mis-wired client surfaces the problem.
    if (view === 'quran' || view === 'code') {
      const key =
        view === 'quran' ? PLUGIN_ISLAMIC_EDUCATION : PLUGIN_CODE_INSTRUCTION;
      if (!(await this.plugins.isEnabled(session.course.organizationId, key))) {
        return this.fail(client, 'PLUGIN_DISABLED', 'Add-on not enabled');
      }
    }
    await this.state.setView(p.sessionId, view);
    this.server
      .to(p.sessionId)
      .emit('view:changed', { sessionId: p.sessionId, view });
  }

  @SubscribeMessage('theme:change')
  async onThemeChange(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; scheme: RoomScheme },
  ) {
    const session = await this.ownedSession(client, p.sessionId);
    if (!session) return;
    if (!(ROOM_SCHEMES as readonly string[]).includes(p.scheme)) {
      return this.fail(client, 'BAD_SCHEME', 'Unknown colour scheme');
    }
    await this.state.setTheme(p.sessionId, p.scheme);
    this.server
      .to(p.sessionId)
      .emit('theme:changed', { sessionId: p.sessionId, scheme: p.scheme });
  }

  @SubscribeMessage('quran:navigate')
  async onQuranNavigate(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; surah: number; ayah: number },
  ) {
    const session = await this.ownedSession(client, p.sessionId);
    if (!session) return;
    // The mushaf is an Islamic Education surface — reject navigation for orgs
    // without the pack, even though the UI already hides the control.
    if (
      !(await this.plugins.isEnabled(
        session.course.organizationId,
        PLUGIN_ISLAMIC_EDUCATION,
      ))
    ) {
      return this.fail(client, 'PLUGIN_DISABLED', 'Add-on not enabled');
    }
    // Clamp to the valid mushaf range; the client picks from the catalog, but
    // never trust it — an out-of-range verse would blank every student's page.
    const surah = Math.min(114, Math.max(1, Math.trunc(Number(p.surah) || 1)));
    const ayah = Math.max(1, Math.trunc(Number(p.ayah) || 1));
    const pos = { surah, ayah };
    await this.state.setQuranPos(p.sessionId, pos);
    this.server
      .to(p.sessionId)
      .emit('quran:position', { sessionId: p.sessionId, ...pos });
  }

  // ---------- Raised hands ----------

  @SubscribeMessage('hand:raise')
  async onHandRaise(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    const user = client.data.user;
    if (!this.inRoom(client, p.sessionId) || user.role !== Role.STUDENT) return;
    await this.state.raiseHand(p.sessionId, this.roomUser(client));
    await this.broadcastHands(p.sessionId);
  }

  @SubscribeMessage('hand:lower')
  async onHandLower(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    await this.state.lowerHand(p.sessionId, client.data.user.sub);
    await this.broadcastHands(p.sessionId);
  }

  @SubscribeMessage('student:pick-random')
  async onPickRandom(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!(await this.isOwner(client, p.sessionId))) return;
    const picked = await this.state.randomHand(p.sessionId);
    if (!picked) {
      return this.fail(client, 'NO_HANDS', 'No raised hands to pick from');
    }
    this.server
      .to(p.sessionId)
      .emit('student:picked', { sessionId: p.sessionId, user: picked });
    // Once someone is picked, the queue resets — lower every raised hand so the
    // next round starts clean rather than re-picking from a stale queue.
    await this.state.clearHands(p.sessionId);
    await this.broadcastHands(p.sessionId);
    // Picking a student to speak grants them the mic for this turn.
    await this.state.grantMic(p.sessionId, picked.userId);
    await this.broadcastSpeakers(p.sessionId);
  }

  // ---------- Buzzer round (who-wants-to-be-a-millionaire style) ----------

  @SubscribeMessage('buzzer:start')
  async onBuzzerStart(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; questionId: string },
  ) {
    const session = await this.ownedSession(client, p.sessionId);
    if (!session) return;

    const current = await this.state.getBuzzerState(p.sessionId);
    if (current?.phase === 'QUESTION_OPEN') {
      return this.fail(client, 'BUZZER_BUSY', 'A question is already open');
    }

    // Open buzzer: every student in the room can race to answer — no need to
    // raise a hand first. First correct answer wins the mic + points.
    const eligible = (await this.state.listPresence(p.sessionId)).filter(
      (u) => u.role === Role.STUDENT,
    );
    if (eligible.length === 0) {
      return this.fail(client, 'NO_STUDENTS', 'No students in the room to quiz');
    }

    const question = await this.prisma.quizQuestion.findUnique({
      where: { id: p.questionId },
      include: {
        quiz: {
          select: {
            sessionId: true,
            courseId: true,
            section: { select: { courseId: true } },
          },
        },
      },
    });
    // Accept a question tied to this exact session OR to this session's course
    // (the reusable buzzer bank).
    const quizCourseId =
      question?.quiz.courseId ?? question?.quiz.section?.courseId ?? null;
    const belongs =
      !!question &&
      (question.quiz.sessionId === p.sessionId ||
        (quizCourseId !== null && quizCourseId === session.courseId));
    if (!belongs) {
      return this.fail(client, 'BAD_QUESTION', 'Question not in this class');
    }

    const publicQuestion: QuizQuestionPublic = {
      questionId: question.id,
      body: question.body,
      options: question.options as string[],
      timeLimitSec: question.timeLimitSec,
      points: question.points,
      openedAt: new Date().toISOString(),
    };
    const state: BuzzerState = {
      phase: 'QUESTION_OPEN',
      eligibleUserIds: eligible.map((u) => u.userId),
      question: publicQuestion,
    };
    await this.state.clearBuzzerAnswered(p.sessionId);
    await this.state.setBuzzerState(p.sessionId, state);
    this.server
      .to(p.sessionId)
      .emit('buzzer:state', { sessionId: p.sessionId, state });
    this.server.to(p.sessionId).emit('quiz:opened', {
      sessionId: p.sessionId,
      question: publicQuestion,
    });

    this.clearTimer(p.sessionId);
    this.buzzerTimers.set(
      p.sessionId,
      setTimeout(() => {
        void this.timeoutBuzzer(p.sessionId, question.id);
      }, question.timeLimitSec * 1000),
    );
  }

  @SubscribeMessage('quiz:answer')
  async onQuizAnswer(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody()
    p: { sessionId: string; questionId: string; answerIndex: number },
  ) {
    // Server receipt order is authoritative: answers race through the
    // Redis answered-set and the first correct one flips the state.
    const user = client.data.user;
    if (!this.inRoom(client, p.sessionId) || user.role !== Role.STUDENT) return;

    const state = await this.state.getBuzzerState(p.sessionId);
    if (
      state?.phase !== 'QUESTION_OPEN' ||
      state.question?.questionId !== p.questionId
    ) {
      return this.fail(client, 'NOT_OPEN', 'Question is not open');
    }
    if (!state.eligibleUserIds.includes(user.sub)) {
      return this.fail(client, 'NOT_ELIGIBLE', 'This round started before you joined');
    }
    if (!(await this.state.markBuzzerAnswered(p.sessionId, user.sub))) {
      return this.fail(client, 'ALREADY_ANSWERED', 'One attempt per question');
    }

    const question = await this.prisma.quizQuestion.findUnique({
      where: { id: p.questionId },
      include: {
        quiz: {
          select: {
            courseId: true,
            session: { select: { courseId: true } },
            section: { select: { courseId: true } },
          },
        },
      },
    });
    if (!question) return;
    const options = question.options as string[];
    const isCorrect =
      p.answerIndex >= 0 &&
      p.answerIndex < options.length &&
      p.answerIndex === question.correctIndex;
    // Course-bank buzzer questions carry `courseId` directly; session/section
    // quizzes resolve through their relation. Any of them identifies the course
    // whose leaderboard this round feeds.
    const courseId =
      question.quiz.courseId ??
      question.quiz.session?.courseId ??
      question.quiz.section?.courseId ??
      undefined;

    // Persist the attempt (ignore repeats from earlier REST answers).
    try {
      await this.prisma.quizAnswer.create({
        data: {
          questionId: p.questionId,
          studentId: user.sub,
          answerIndex: p.answerIndex,
          isCorrect,
        },
      });
    } catch (e) {
      if (
        !(e instanceof Prisma.PrismaClientKnownRequestError) ||
        e.code !== 'P2002'
      ) {
        throw e;
      }
    }

    client.emit('quiz:answer-result', {
      questionId: p.questionId,
      isCorrect,
    });
    if (!isCorrect) return;

    // First correct answer wins — re-check state so a concurrent winner
    // can't be overwritten.
    const latest = await this.state.getBuzzerState(p.sessionId);
    if (latest?.phase !== 'QUESTION_OPEN') return;

    this.clearTimer(p.sessionId);
    const winnerState: BuzzerState = {
      phase: 'WINNER',
      eligibleUserIds: latest.eligibleUserIds,
      question: latest.question,
      winner: this.roomUser(client),
    };
    await this.state.setBuzzerState(p.sessionId, winnerState);

    if (courseId) {
      // The instructor sets the stake per question; fall back to the default.
      const delta = question.points ?? POINTS_BUZZER_WIN;
      await this.points.award({
        studentId: user.sub,
        courseId,
        delta,
        reason: PointsReason.BUZZER_WIN,
        refId: p.questionId,
      });
      const entries = await this.points.leaderboard(courseId);
      this.server
        .to(p.sessionId)
        .emit('leaderboard:update', { sessionId: p.sessionId, entries });
    }

    // First correct answer closes the round for everyone. The buzzer is an
    // engagement check, not a speaking queue — it never touches raised hands.
    this.server
      .to(p.sessionId)
      .emit('buzzer:state', { sessionId: p.sessionId, state: winnerState });
    this.server.to(p.sessionId).emit('quiz:closed', {
      sessionId: p.sessionId,
      questionId: p.questionId,
    });
  }

  // ---------- Screen share (LiveKit permission bridge) ----------

  @SubscribeMessage('screen-share:grant')
  async onScreenShareGrant(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; userId: string },
  ) {
    await this.setScreenShare(client, p, true);
  }

  @SubscribeMessage('screen-share:revoke')
  async onScreenShareRevoke(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; userId: string },
  ) {
    await this.setScreenShare(client, p, false);
  }

  // ---------- Mic permission (students are muted until granted) ----------

  @SubscribeMessage('mic:grant')
  async onMicGrant(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; userId: string },
  ) {
    if (!(await this.isOwner(client, p.sessionId))) return;
    await this.state.grantMic(p.sessionId, p.userId);
    await this.broadcastSpeakers(p.sessionId);
  }

  @SubscribeMessage('mic:revoke')
  async onMicRevoke(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; userId: string },
  ) {
    if (!(await this.isOwner(client, p.sessionId))) return;
    await this.state.revokeMic(p.sessionId, p.userId);
    await this.broadcastSpeakers(p.sessionId);
  }

  // ---------- Internals ----------

  private async setScreenShare(
    client: RoomSocket,
    p: { sessionId: string; userId: string },
    grant: boolean,
  ) {
    const session = await this.ownedSession(client, p.sessionId);
    if (!session) return;
    try {
      await this.livekit.setPublishPermission(
        session.livekitRoom,
        p.userId,
        grant,
      );
    } catch (e) {
      this.logger.warn(`LiveKit permission update failed: ${String(e)}`);
      return this.fail(
        client,
        'LIVEKIT_UNAVAILABLE',
        'Could not update media permissions',
      );
    }
    this.server
      .to(p.sessionId)
      .emit(grant ? 'screen-share:granted' : 'screen-share:revoked', {
        sessionId: p.sessionId,
        userId: p.userId,
      });
  }

  private async timeoutBuzzer(sessionId: string, questionId: string) {
    this.buzzerTimers.delete(sessionId);
    const state = await this.state.getBuzzerState(sessionId);
    if (
      state?.phase !== 'QUESTION_OPEN' ||
      state.question?.questionId !== questionId
    ) {
      return;
    }
    const timeoutState: BuzzerState = {
      phase: 'TIMEOUT',
      eligibleUserIds: state.eligibleUserIds,
      question: state.question,
    };
    await this.state.setBuzzerState(sessionId, timeoutState);
    this.server
      .to(sessionId)
      .emit('buzzer:state', { sessionId, state: timeoutState });
    this.server.to(sessionId).emit('quiz:closed', { sessionId, questionId });
  }

  private clearTimer(sessionId: string) {
    const t = this.buzzerTimers.get(sessionId);
    if (t) clearTimeout(t);
    this.buzzerTimers.delete(sessionId);
  }

  private async broadcastPresence(sessionId: string) {
    this.server.to(sessionId).emit('room:presence', {
      sessionId,
      users: await this.state.listPresence(sessionId),
    });
  }

  private async broadcastHands(sessionId: string, only?: RoomSocket) {
    const payload = {
      sessionId,
      raised: await this.state.listHands(sessionId),
    };
    (only ?? this.server.to(sessionId)).emit('hands:update', payload);
  }

  private async broadcastSpeakers(sessionId: string, only?: RoomSocket) {
    const payload = {
      sessionId,
      userIds: await this.state.listSpeakers(sessionId),
    };
    (only ?? this.server.to(sessionId)).emit('mic:speakers', payload);
  }

  private inRoom(client: RoomSocket, sessionId: string): boolean {
    if (client.rooms.has(sessionId)) return true;
    this.fail(client, 'NOT_IN_ROOM', 'Join the room first');
    return false;
  }

  private async isOwner(client: RoomSocket, sessionId: string) {
    return (await this.ownedSession(client, sessionId)) !== null;
  }

  private async ownedSession(client: RoomSocket, sessionId: string) {
    const user = client.data.user;
    const isInstructor = user.role === Role.INSTRUCTOR;
    // A teach-mode admin hosts any live session in their own org.
    const isTeachingAdmin =
      user.role === Role.ORG_ADMIN && client.data.teaching === true;
    if (!isInstructor && !isTeachingAdmin) {
      this.fail(client, 'FORBIDDEN', 'Instructor only');
      return null;
    }
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: {
        course: { select: { instructorId: true, organizationId: true } },
      },
    });
    const owns = isInstructor
      ? session?.course.instructorId === user.sub
      : session?.course.organizationId === user.organizationId;
    if (!session || !owns) {
      this.fail(client, 'FORBIDDEN', 'Not your session');
      return null;
    }
    return session;
  }

  /** The role this socket acts as: a teach-mode admin behaves as INSTRUCTOR
   *  (host powers, visible presence); everyone else is their own account role. */
  private actingRole(client: RoomSocket): Role {
    const user = client.data.user;
    return client.data.teaching ? Role.INSTRUCTOR : user.role;
  }

  /** Presence/author identity for this socket, using its acting role so a
   *  teach-mode admin appears to the room as the instructor. */
  private roomUser(client: RoomSocket): RoomUser {
    const user = client.data.user;
    return { userId: user.sub, name: user.name, role: this.actingRole(client) };
  }

  private fail(client: RoomSocket, code: string, message: string) {
    client.emit('error', { code, message });
  }
}
