import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const redisAdapter = new RedisIoAdapter(app);
  await redisAdapter.connectToRedis(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
  );
  app.useWebSocketAdapter(redisAdapter);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
