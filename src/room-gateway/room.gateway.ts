import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '../shared';
import type { Server, Socket } from 'socket.io';

type RoomServer = Server<ClientToServerEvents, ServerToClientEvents>;
type RoomSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

@WebSocketGateway({ cors: { origin: true } })
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RoomGateway.name);

  @WebSocketServer()
  server!: RoomServer;

  handleConnection(client: RoomSocket) {
    // TODO(auth): validate JWT from handshake, attach user to socket.data
    this.logger.debug(`connected ${client.id}`);
  }

  handleDisconnect(client: RoomSocket) {
    // TODO(presence): remove from Redis presence set, broadcast room:presence
    this.logger.debug(`disconnected ${client.id}`);
  }

  @SubscribeMessage('room:join')
  async onJoin(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    await client.join(p.sessionId);
    // TODO(presence): add to Redis presence set, emit room:presence to room
  }

  @SubscribeMessage('chat:send')
  async onChat(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; body: string },
  ) {
    // TODO(chat): reject when chat is locked; persist via ChatMessage; then:
    // this.server.to(p.sessionId).emit('chat:message', saved)
  }

  @SubscribeMessage('hand:raise')
  async onHandRaise(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    // TODO(hands): SADD hands:{sessionId}, broadcast hands:update
  }

  @SubscribeMessage('quiz:answer')
  async onQuizAnswer(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() p: { sessionId: string; questionId: string; answerIndex: number },
  ) {
    // TODO(quiz): server receipt time is authoritative — record Date.now()
    // BEFORE any validation, then hand off to QuizService.
  }
}
