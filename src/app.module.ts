import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthCacheModule } from './auth/auth-cache.service';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { RoomGatewayModule } from './room-gateway/room-gateway.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { CoursesModule } from './courses/courses.module';
import { GroupsModule } from './groups/groups.module';
import { PluginsModule } from './plugins/plugins.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { AssessmentModule } from './assessment/assessment.module';
import { SessionsModule } from './sessions/sessions.module';
import { QuizModule } from './quiz/quiz.module';
import { PointsModule } from './points/points.module';
import { CertificatesModule } from './certificates/certificates.module';
import { BoardModule } from './board/board.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Baseline abuse protection: 120 requests / minute per IP across the API.
    // Auth endpoints tighten this further via @Throttle. NOTE: default storage
    // is in-memory (per-instance) — switch to a Redis store for multi-instance.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthCacheModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
        );
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            // BullMQ requirement for blocking worker connections
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    PrismaModule,
    RedisModule,
    StorageModule,
    RoomGatewayModule,
    AuthModule,
    OrganizationsModule,
    PluginsModule,
    CoursesModule,
    GroupsModule,
    AssignmentsModule,
    AssessmentModule,
    SessionsModule,
    QuizModule,
    PointsModule,
    CertificatesModule,
    BoardModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
