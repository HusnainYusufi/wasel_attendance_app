import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPORT_STALL_POLL_MS,
  EXPORT_STALL_TIMEOUT_MS,
  OBSERVED_SLOW_CLIENT_SILENCE_MS,
  installResponseDeadline,
  type DeadlineResponse,
} from '../export/response-deadline.js';

/** Just enough of a `ServerResponse` to drive the deadline. */
class FakeResponse implements DeadlineResponse {
  destroyed = false;
  socket: { bytesWritten: number } | null = { bytesWritten: 0 };
  destroyCalls = 0;

  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
  }

  /** The client accepted `bytes` more, so the export handed the socket more. */
  deliver(bytes: number): void {
    if (this.socket !== null) this.socket.bytesWritten += bytes;
  }
}

const TIMEOUT_MS = 1000;
const POLL_MS = 100;
const options = { timeoutMs: TIMEOUT_MS, pollMs: POLL_MS };

/** Progress this rare is still progress — but only just. */
const NEARLY_STALLED_MS = TIMEOUT_MS - 2 * POLL_MS;

describe('installResponseDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a response that never makes any progress', () => {
    const response = new FakeResponse();
    const deadline = installResponseDeadline(response, options);

    vi.advanceTimersByTime(TIMEOUT_MS - POLL_MS);
    expect(response.destroyed).toBe(false);
    expect(deadline.expired).toBe(false);

    vi.advanceTimersByTime(POLL_MS);
    expect(response.destroyed).toBe(true);
    expect(deadline.expired).toBe(true);
  });

  it('never fires on a slow download that is still moving', () => {
    const response = new FakeResponse();
    const deadline = installResponseDeadline(response, options);

    // A client that accepts one high-water mark of data with almost the whole
    // budget between rounds — the worst case that is still a real download, and
    // the one a total-duration limit would kill. Ten budgets' worth of it, and
    // the socket is untouched.
    for (let round = 0; round < 10; round += 1) {
      vi.advanceTimersByTime(NEARLY_STALLED_MS);
      response.deliver(64 * 1024);
    }

    expect(response.destroyed).toBe(false);
    expect(deadline.expired).toBe(false);
  });

  it('does not blame the client when the export itself is making progress', () => {
    // A database that has gone slow hands the socket no bytes, which at the
    // socket is indistinguishable from a client that stopped reading. `touch` is
    // the signal that tells the two apart.
    const response = new FakeResponse();
    const deadline = installResponseDeadline(response, options);

    for (let round = 0; round < 10; round += 1) {
      vi.advanceTimersByTime(NEARLY_STALLED_MS);
      deadline.touch();
    }

    expect(response.destroyed).toBe(false);
  });

  it('reports the expiry once, through the callback', () => {
    const onExpire = vi.fn();
    const response = new FakeResponse();
    installResponseDeadline(response, { ...options, onExpire });

    vi.advanceTimersByTime(TIMEOUT_MS * 5);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(response.destroyCalls).toBe(1);
  });

  it('stops when cleared, and is safe to clear twice', () => {
    const response = new FakeResponse();
    const deadline = installResponseDeadline(response, options);

    deadline.clear();
    deadline.clear();
    vi.advanceTimersByTime(TIMEOUT_MS * 5);

    expect(response.destroyed).toBe(false);
    expect(deadline.expired).toBe(false);
  });

  it('leaves a response somebody else already destroyed alone', () => {
    const response = new FakeResponse();
    installResponseDeadline(response, options);

    response.destroyed = true;
    vi.advanceTimersByTime(TIMEOUT_MS * 5);

    // The abort path already destroyed it; a second `destroy` would log a second,
    // confusing failure for one event.
    expect(response.destroyCalls).toBe(0);
  });

  it('survives a socket that has already been detached', () => {
    const response = new FakeResponse();
    response.socket = null;
    installResponseDeadline(response, options);

    expect(() => vi.advanceTimersByTime(TIMEOUT_MS * 2)).not.toThrow();
    expect(response.destroyed).toBe(true);
  });

  it('clears the silence a healthy slow download actually produces', () => {
    // The shipped numbers, not the test's, and the reason the budget is minutes
    // rather than seconds. `socket.bytesWritten` does not trickle: the sender goes
    // quiet while the in-flight buffer drains and then accepts a burst, so a
    // perfectly healthy 16 kB/s download was measured silent for 35 s at a stretch.
    // A budget within an order of magnitude of that kills real payroll downloads.
    expect(EXPORT_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(OBSERVED_SLOW_CLIENT_SILENCE_MS * 10);
    // And it is sampled often enough that no single delayed timer decides the
    // outcome, which a two- or three-sample budget could not promise.
    expect(EXPORT_STALL_TIMEOUT_MS / EXPORT_STALL_POLL_MS).toBeGreaterThanOrEqual(8);
  });
});
