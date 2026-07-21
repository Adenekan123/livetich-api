import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { PointsReason, Prisma, Role, SessionStatus } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../auth/jwt-payload';
import { PointsService, POINTS_BUZZER_WIN } from '../points/points.service';
import { PrismaService } from '../prisma/prisma.service';
import { LivekitService } from '../sessions/livekit.service';
import type {
  BuzzerState,
  ClientToServerEvents,
  QuizQuestionPublic,
  RoomUser,
  ServerToClientEvents,
} from '../shared';
import { RoomStateService } from './room-state.service';

interface SocketData {
  user: JwtPayload;
  sessionIds: Set<string>;
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

@WebSocketGateway({ cors: { origin: true } })
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
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
  ) {}

  // ---------- Connection lifecycle ----------

  async handleConnection(client: RoomSocket) {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.split(' ')[1];
    try {
      client.data.user = await this.jwt.verifyAsync<JwtPayload>(token ?? '');
      client.data.sessionIds = new Set();
    } catch {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
    }
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
    @MessageBody() p: { sessionId: string },
  ) {
    const user = client.data.user;
    const session = await this.prisma.liveSession.findUnique({
      where: { id: p.sessionId },
      include: { course: { select: { id: true, instructorId: true } } },
    });
    if (!session || session.status === SessionStatus.ENDED) {
      return this.fail(client, 'NOT_JOINABLE', 'Session not found or ended');
    }

    if (user.role === Role.INSTRUCTOR) {
      if (session.course.instructorId !== user.sub) {
        return this.fail(client, 'FORBIDDEN', 'Not your session');
      }
    } else {
      if (session.status !== SessionStatus.LIVE) {
        return this.fail(client, 'NOT_LIVE', 'Session is not live yet');
      }
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
    client.data.sessionIds.add(p.sessionId);
    await this.state.addPresence(p.sessionId, this.roomUser(user));
    await this.broadcastPresence(p.sessionId);
    // Late joiners still need current room state:
    client.emit('chat:locked', {
      sessionId: p.sessionId,
      locked: await this.state.isChatLocked(p.sessionId),
    });
    await this.broadcastHands(p.sessionId, client);
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
      user.role !== Role.INSTRUCTOR &&
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
      user: this.roomUser(user),
      body,
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

  // ---------- Raised hands ----------

  @SubscribeMessage('hand:raise')
  async onHandRaise(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    const user = client.data.user;
    if (!this.inRoom(client, p.sessionId) || user.role !== Role.STUDENT) return;
    await this.state.raiseHand(p.sessionId, this.roomUser(user));
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

    const eligible = await this.state.listHands(p.sessionId);
    if (eligible.length === 0) {
      return this.fail(client, 'NO_HANDS', 'No raised hands — nobody to quiz');
    }

    const question = await this.prisma.quizQuestion.findUnique({
      where: { id: p.questionId },
      include: { quiz: { select: { sessionId: true, sectionId: true } } },
    });
    if (!question || question.quiz.sessionId !== p.sessionId) {
      return this.fail(client, 'BAD_QUESTION', 'Question not in this session');
    }

    const publicQuestion: QuizQuestionPublic = {
      questionId: question.id,
      body: question.body,
      options: question.options as string[],
      timeLimitSec: question.timeLimitSec,
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
      return this.fail(client, 'NOT_ELIGIBLE', 'You did not raise your hand');
    }
    if (!(await this.state.markBuzzerAnswered(p.sessionId, user.sub))) {
      return this.fail(client, 'ALREADY_ANSWERED', 'One attempt per question');
    }

    const question = await this.prisma.quizQuestion.findUnique({
      where: { id: p.questionId },
      include: {
        quiz: { select: { session: { select: { courseId: true } } } },
      },
    });
    if (!question) return;
    const options = question.options as string[];
    const isCorrect =
      p.answerIndex >= 0 &&
      p.answerIndex < options.length &&
      p.answerIndex === question.correctIndex;
    const courseId = question.quiz.session?.courseId;

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
      winner: this.roomUser(user),
    };
    await this.state.setBuzzerState(p.sessionId, winnerState);
    await this.state.clearHands(p.sessionId);

    if (courseId) {
      await this.points.award({
        studentId: user.sub,
        courseId,
        delta: POINTS_BUZZER_WIN,
        reason: PointsReason.BUZZER_WIN,
        refId: p.questionId,
      });
      const entries = await this.points.leaderboard(courseId);
      this.server
        .to(p.sessionId)
        .emit('leaderboard:update', { sessionId: p.sessionId, entries });
    }

    this.server
      .to(p.sessionId)
      .emit('buzzer:state', { sessionId: p.sessionId, state: winnerState });
    this.server.to(p.sessionId).emit('quiz:closed', {
      sessionId: p.sessionId,
      questionId: p.questionId,
    });
    await this.broadcastHands(p.sessionId);
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
    if (user.role !== Role.INSTRUCTOR) {
      this.fail(client, 'FORBIDDEN', 'Instructor only');
      return null;
    }
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: { course: { select: { instructorId: true } } },
    });
    if (!session || session.course.instructorId !== user.sub) {
      this.fail(client, 'FORBIDDEN', 'Not your session');
      return null;
    }
    return session;
  }

  private roomUser(user: JwtPayload): RoomUser {
    return { userId: user.sub, name: user.name, role: user.role };
  }

  private fail(client: RoomSocket, code: string, message: string) {
    client.emit('error', { code, message });
  }
}
