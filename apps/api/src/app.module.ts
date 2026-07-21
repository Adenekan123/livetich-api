import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { RoomGatewayModule } from './room-gateway/room-gateway.module';
import { AuthModule } from './auth/auth.module';
import { CoursesModule } from './courses/courses.module';
import { SessionsModule } from './sessions/sessions.module';
import { QuizModule } from './quiz/quiz.module';
import { PointsModule } from './points/points.module';
import { CertificatesModule } from './certificates/certificates.module';
import { BoardModule } from './board/board.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RoomGatewayModule,
    AuthModule,
    CoursesModule,
    SessionsModule,
    QuizModule,
    PointsModule,
    CertificatesModule,
    BoardModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
