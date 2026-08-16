import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness + readiness probe for the container orchestrator, the reverse proxy,
 * and uptime monitoring. Public + un-throttled so health checks never need a
 * token and never eat into the rate limit. Returns 503 (not 200) when the
 * database is unreachable so a bad instance is pulled out of rotation.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', db: false });
    }
    return {
      status: 'ok',
      db: true,
      uptime: Math.round(process.uptime()),
      ts: new Date().toISOString(),
    };
  }
}
