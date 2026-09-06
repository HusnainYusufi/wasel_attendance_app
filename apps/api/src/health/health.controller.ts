import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorCode } from '@wasel/contracts';
import { Public } from '../common/auth/public.decorator.js';
import { ClockService } from '../common/clock/clock.service.js';
import { AppException } from '../common/errors/app.exception.js';
import type { JsonSchema } from '../common/openapi/contract-schemas.js';
import { ApiErrorResponses } from '../common/openapi/zod-api.decorators.js';
import { DATABASE_PING_TIMEOUT_MS, DatabaseProbe } from './database-probe.js';
import type { LivenessBody, ReadinessBody } from './health.types.js';

const LIVENESS_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['status', 'uptimeSeconds', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
    uptimeSeconds: { type: 'integer', example: 3_600 },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const READINESS_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['status', 'checks', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
    checks: {
      type: 'object',
      required: ['database'],
      properties: { database: { type: 'string', enum: ['ok'] } },
    },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

// Probes fire every few seconds from every replica; throttling them would take
// the service out of rotation under exactly the load the limit exists to survive.
@SkipThrottle()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseProbe,
    private readonly clock: ClockService,
  ) {}

  @Public()
  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Succeeds while the process is running. Never touches the database.',
  })
  @ApiResponse({ status: 200, description: 'The process is running', schema: LIVENESS_SCHEMA })
  live(): LivenessBody {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: this.clock.now().toISOString(),
    };
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Executes `SELECT 1` on a connection reserved for the probe, so that a ' +
      'saturated application pool does not read as an unreachable database. ' +
      'Returns 503 while the database is unreachable.',
  })
  @ApiResponse({
    status: 200,
    description: 'The instance can serve traffic',
    schema: READINESS_SCHEMA,
  })
  @ApiErrorResponses(503)
  async ready(): Promise<ReadinessBody> {
    try {
      await this.withTimeout(this.database.ping(), DATABASE_PING_TIMEOUT_MS);
    } catch {
      // The cause is deliberately not forwarded: a connection error message
      // carries the database host, port and user.
      throw new AppException(503, ErrorCode.INTERNAL_ERROR, 'Service is not ready', [
        { path: 'database', message: 'unreachable' },
      ]);
    }

    return {
      status: 'ok',
      checks: { database: 'ok' },
      timestamp: this.clock.now().toISOString(),
    };
  }

  private async withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), ms);
          // Do not hold the event loop open on a timer that only guards a probe.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
