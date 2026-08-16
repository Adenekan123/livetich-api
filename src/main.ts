import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers (HSTS, nosniff, no-framing, …). The API is consumed by the
  // web app on another origin, so resources may be read cross-origin.
  app.use(
    helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }),
  );

  // CORS must be pinned in production — never reflect an arbitrary origin while
  // sending credentials. Dev falls back to reflecting the request origin.
  const webOrigin = process.env.WEB_ORIGIN;
  if (process.env.NODE_ENV === 'production' && !webOrigin) {
    throw new Error('WEB_ORIGIN must be set in production');
  }
  app.enableCors({ origin: webOrigin ?? true, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const redisAdapter = new RedisIoAdapter(app);
  await redisAdapter.connectToRedis(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
  );
  app.useWebSocketAdapter(redisAdapter);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
