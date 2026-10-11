import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis/redis-io.adapter';

async function bootstrap() {
  // rawBody: LiveKit signs its webhooks over the exact bytes it sent, so the
  // parsed object is not enough to verify one.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Trust proxy headers (X-Forwarded-For, CF-Connecting-IP, etc.) from reverse
  // proxies like Caddy and Cloudflare so req.ip and rate limiters reflect real clients.
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', true);

  // Security headers (HSTS, nosniff, no-framing, …). The API is consumed by the
  // web app on another origin, so resources may be read cross-origin.
  app.use(
    helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }),
  );

  // CORS must be pinned in production — allow configured origin as well as
  // official livetich.com origins and legacy aliases.
  const webOrigin = process.env.WEB_ORIGIN;
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean | string) => void,
    ) => {
      if (!origin || process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
      if (
        origin === webOrigin ||
        origin === 'https://livetich.com' ||
        origin === 'https://app.livetich.com' ||
        origin === 'https://livetich.nekan.dev' ||
        /^https:\/\/([a-z0-9-]+\.)?livetich\.com$/i.test(origin)
      ) {
        return callback(null, origin);
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  });

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
