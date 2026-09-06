import { ClockService } from '../../src/common/clock/clock.service.js';

/**
 * A clock a test can move.
 *
 * Attendance logic is full of boundaries — the workday start, the late grace
 * window, midnight in the organisation's timezone — and every one of them is
 * untestable against a clock that only ever says "now".
 */
export class FixedClockService extends ClockService {
  constructor(private current: Date) {
    super();
  }

  override now(): Date {
    return new Date(this.current);
  }

  set(next: Date): void {
    this.current = next;
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
