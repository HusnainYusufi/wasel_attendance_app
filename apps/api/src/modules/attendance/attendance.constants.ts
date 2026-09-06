import { MIN_SHIFT_MINUTES } from '@wasel/contracts';

/**
 * How long after check-in an unclosed shift may still be closed by a check-out
 * that lands on the **next** work date.
 *
 * This is the answer to the overnight question: someone who checks in at 23:50
 * and out at 00:10 is one person finishing one shift, and losing that check-out
 * because the calendar rolled over is not acceptable. The window is bounded so
 * that a check-out cannot be attached to a shift nobody was working — an 18-hour
 * cap admits every night shift and every honest overrun while refusing to
 * manufacture a 30-hour day out of a punch somebody forgot.
 *
 * See `attendance.service.ts` for the second half of the rule: a carry-over is
 * only eligible while the user has no record at all for the current work date,
 * because checking in again is itself evidence the previous shift ended.
 */
export const MAX_CARRY_OVER_SHIFT_HOURS = 18;

export const MAX_CARRY_OVER_SHIFT_MS = MAX_CARRY_OVER_SHIFT_HOURS * 60 * 60 * 1000;

/**
 * The other end of the same question: the shortest gap between a check-in and
 * the check-out that closes it.
 *
 * Measured in milliseconds rather than through `minutesBetween`, which rounds —
 * a forty-second shift would round *up* to one minute and slip past a check on
 * the rounded value. The invariant this buys is worth stating plainly: an
 * accepted check-out always stores `workedMinutes >= 1`.
 */
export const MIN_SHIFT_MS = MIN_SHIFT_MINUTES * 60 * 1000;

/**
 * Metres as stored and returned: truncated to a tenth, never rounded up.
 *
 * Consumer GNSS resolves to metres at best, so the digits past a tenth are float
 * noise; keeping them makes two identical fixes look like different distances in
 * an export. Truncating rather than rounding buys one more property, and it is
 * the one that matters when somebody disputes a rejection: a stored distance is
 * never larger than the one the fence was judged against. Rounding turned an
 * accepted 149.96 m into a stored `150.0` against a 150 m fence —
 * indistinguishable, in an export, from the punch that was refused for being on
 * the wrong side of that exact line.
 */
export function storedMeters(value: number): number {
  return Math.floor(value * 10) / 10;
}
