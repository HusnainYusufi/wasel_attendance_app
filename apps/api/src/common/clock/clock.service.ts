import { Injectable } from '@nestjs/common';

/**
 * The server's authoritative clock.
 *
 * Every service reads time through this rather than calling `new Date()`, for
 * two reasons. Tests can freeze it, which is the only practical way to cover the
 * midnight and DST boundaries where attendance bugs actually live. And it keeps
 * the rule visible: the server clock decides `workDate`, never the `deviceTime`
 * a phone reports, which a user can set to yesterday.
 */
@Injectable()
export class ClockService {
  now(): Date {
    return new Date();
  }

  /** Milliseconds since the epoch. Convenience for duration arithmetic. */
  nowMs(): number {
    return this.now().getTime();
  }
}
