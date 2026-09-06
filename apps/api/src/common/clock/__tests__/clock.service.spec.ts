import { describe, expect, it, vi } from 'vitest';
import { ClockService } from '../clock.service.js';

describe('ClockService', () => {
  it('returns the current instant', () => {
    vi.useFakeTimers();
    try {
      const instant = new Date('2026-03-01T12:34:56.000Z');
      vi.setSystemTime(instant);

      expect(new ClockService().now().toISOString()).toBe(instant.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes epoch milliseconds consistently with now()', () => {
    const clock = new ClockService();
    const before = clock.nowMs();
    const now = clock.now().getTime();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now - before).toBeLessThan(1_000);
  });

  it('is overridable, which is the whole point of injecting it', () => {
    const frozen = new Date('2026-01-01T00:00:00.000Z');

    class FrozenClock extends ClockService {
      override now(): Date {
        return frozen;
      }
    }

    const clock: ClockService = new FrozenClock();
    expect(clock.now()).toBe(frozen);
    expect(clock.nowMs()).toBe(frozen.getTime());
  });
});
