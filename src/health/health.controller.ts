import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { connection } from '../interfaces/redis/queues.js';

@Controller('health')
export class HealthController {
  @Get()
  async check(@Res() res: Response): Promise<void> {
    const checks: Record<
      string,
      { status: 'up' | 'down'; latency_ms: number }
    > = {};

    const timeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), ms),
        ),
      ]);

    const redisStart = Date.now();
    try {
      const pong = await timeout(connection.ping(), 5_000);
      checks.redis = {
        status: pong === 'PONG' ? 'up' : 'down',
        latency_ms: Date.now() - redisStart,
      };
    } catch {
      checks.redis = {
        status: 'down',
        latency_ms: Date.now() - redisStart,
      };
    }

    const allUp = Object.values(checks).every((c) => c.status === 'up');
    const status = allUp ? 'ok' : 'degraded';

    const body = {
      status,
      checks,
      uptime_ms: process.uptime() * 1000,
    };

    res
      .status(allUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json(body);
  }
}
