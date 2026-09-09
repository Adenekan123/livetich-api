import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('Redis');
        const client = new Redis(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          {
            maxRetriesPerRequest: 2,
            // Cap every command so a dead/blocked Redis fails over to the DB in
            // ~2s instead of hanging ~10s while the socket times out — that hang
            // is what made joining a session crawl during an outage. Normal
            // commands are sub-millisecond, so this ceiling is never hit in
            // healthy operation.
            commandTimeout: 2000,
            // Keep reconnecting with a capped backoff so a transient Redis
            // outage self-heals instead of staying down.
            retryStrategy: (times) => Math.min(times * 200, 5000),
          },
        );
        // CRITICAL: without an 'error' listener, ioredis re-emits every
        // connection error as an uncaught exception and the whole API process
        // dies (users then see "server not found" until it restarts). Log it
        // and let the retry strategy reconnect in the background instead.
        client.on('error', (err) =>
          logger.warn(`connection error: ${err.message}`),
        );
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
