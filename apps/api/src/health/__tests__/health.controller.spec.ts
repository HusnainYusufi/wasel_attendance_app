import { ErrorCode } from '@wasel/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ClockService } from '../../common/clock/clock.service.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { DatabaseProbe } from '../database-probe.js';
import { HealthController } from '../health.controller.js';

const FROZEN = new Date('2026-05-05T10:00:00.000Z');

class FrozenClock extends ClockService {
  override now(): Date {
    return FROZEN;
  }
}

function controllerWith(ping: () => Promise<void>): HealthController {
  return new HealthController({ ping } as unknown as DatabaseProbe, new FrozenClock());
}

describe('HealthController.live', () => {
  it('reports liveness from the injected clock without touching the database', () => {
    const ping = vi.fn(() => Promise.resolve());
    const body = controllerWith(ping).live();

    expect(body).toMatchObject({ status: 'ok', timestamp: FROZEN.toISOString() });
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(ping).not.toHaveBeenCalled();
  });
});

describe('HealthController.ready', () => {
  it('reports readiness after a successful ping', async () => {
    const ping = vi.fn(() => Promise.resolve());
    await expect(controllerWith(ping).ready()).resolves.toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('answers 503 when the database rejects', async () => {
    const controller = controllerWith(() =>
      Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    );

    try {
      await controller.ready();
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const exception = error as AppException;
      expect(exception.getStatus()).toBe(503);
      expect(exception.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(exception.details).toEqual([{ path: 'database', message: 'unreachable' }]);
      expect(JSON.stringify(exception.getResponse())).not.toContain('10.0.0.5');
      return;
    }
    throw new Error('expected ready() to reject');
  });

  it('fails fast instead of hanging when the database never answers', async () => {
    vi.useFakeTimers();
    try {
      const controller = controllerWith(() => new Promise<void>(() => undefined));
      const pending = controller.ready();
      const assertion = expect(pending).rejects.toBeInstanceOf(AppException);

      await vi.advanceTimersByTimeAsync(2_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
