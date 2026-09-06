import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter backed by Redis pub/sub so the gateway can scale to
 * multiple instances (room broadcasts fan out across all of them).
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private readonly logger = new Logger('RedisIoAdapter');

  async connectToRedis(url: string): Promise<void> {
    const pubClient = new Redis(url, { maxRetriesPerRequest: 2 });
    const subClient = pubClient.duplicate();
    // An unhandled 'error' event on either client would crash the API process
    // when Redis blips; log and let ioredis reconnect on its own instead.
    pubClient.on('error', (err) =>
      this.logger.warn(`pub connection error: ${err.message}`),
    );
    subClient.on('error', (err) =>
      this.logger.warn(`sub connection error: ${err.message}`),
    );
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
