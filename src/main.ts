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

  // Route isolated preview origins back through the authenticated proxy. Each
  // session/port gets its own origin, keeping framework assets and app routes
  // rooted at `/` without requiring framework-specific base-path settings.
  const previewDomain = process.env.PREVIEW_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  expressApp.use((req: import('express').Request, _res: import('express').Response, next: () => void) => {
    const host = req.hostname.toLowerCase();
    let subdomain: string | undefined;
    if (previewDomain && host.endsWith(`.${previewDomain}`)) {
      subdomain = host.slice(0, -(previewDomain.length + 1));
    } else if (process.env.NODE_ENV !== 'production' && host.endsWith('.localhost')) {
      subdomain = host.slice(0, -'.localhost'.length);
    }
    const match = subdomain?.match(/^(.+)-(\d{1,5})$/);
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65535) return next();

    const originalUrl = req.url || '/';
    const appPath = originalUrl.startsWith('/') ? originalUrl : `/${originalUrl}`;
    req.url = `/proxy/${encodeURIComponent(match[1])}/${port}${appPath}`;
    req.originalUrl = req.url;
    next();
  });

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
