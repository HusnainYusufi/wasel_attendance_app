/**
 * A stall deadline for a streamed response.
 *
 * Node applies no timeout to a *response*. `server.requestTimeout` bounds how
 * long a client may take to **send** a request and stops counting once the
 * request is complete; nothing bounds how long it may take to read the answer.
 * Backpressure fixed the memory half of that (`export-sink.ts`) and the socket's
 * `close` event fixed the aborted half (`awaitDrain`), but a client that opens an
 * export, reads nothing and never hangs up leaves a live socket, a suspended
 * generator and an in-flight request that `app.close()` will wait on through a
 * rolling deploy — for as long as it likes. TCP alone will not end it: a peer
 * that advertises a zero window is, at the transport layer, simply busy.
 *
 * The deadline is therefore on **stalling, not on duration**. A total time limit
 * is the obvious implementation and the wrong one: the exports that take longest
 * are precisely the legitimate ones — a year-end payroll extract for a large
 * tenant over a hotel connection — and killing those is worse than the leak,
 * because it converts a rare resource problem into a routine data-delivery
 * failure that the administrator cannot work around.
 */

/** The parts of an `http.ServerResponse` this needs. Narrow, so it is testable. */
export interface DeadlineResponse {
  readonly destroyed: boolean;
  readonly socket: { readonly bytesWritten: number } | null;
  destroy(error?: Error): void;
}

/**
 * The longest measured silence from a client that was making perfect progress.
 *
 * Not a knob — a measurement, kept here because it is the number
 * {@link EXPORT_STALL_TIMEOUT_MS} has to clear. A 4 MB response read at 16 kB/s
 * produced these gaps between successive increases of `socket.bytesWritten`:
 *
 * ```
 *   5.0s  +852 kB          60.0s  +524 kB   (30 s silent)
 *  25.0s  +590 kB (20 s)   90.0s  +590 kB   (30 s silent)
 *  30.0s   +66 kB         125.0s +1508 kB   (35 s silent)
 * ```
 *
 * The sender does not trickle; it goes quiet while the in-flight buffer drains
 * and then accepts a burst. The silence is therefore `burst ÷ read rate`, not a
 * property of the writer — and it is exactly what a naive deadline mistakes for a
 * dead client.
 */
export const OBSERVED_SLOW_CLIENT_SILENCE_MS = 35_000;

/**
 * How long the export may make no progress at all before the socket is closed.
 *
 * Progress means either the client accepted more bytes or the export completed
 * another batch, so this is an *idle* budget rather than a total one: a download
 * that keeps moving is never touched however long it runs.
 *
 * Ten minutes, and the arithmetic is the reason it is not the two or three that
 * intuition suggests. The only sender-side evidence of a live peer is the socket
 * accepting more data, and per {@link OBSERVED_SLOW_CLIENT_SILENCE_MS} that
 * happens once per `in-flight buffer ÷ read rate` — 35 seconds, measured, for a
 * perfectly healthy 16 kB/s download. Running the same relation the other way:
 * 600 s of silence against a ~600 kB burst means the peer sustained under
 * **1 kB/s**, at which rate the 4 MB month above needs an hour and the year-end
 * extract this route exists for is simply not going to arrive. A client that slow
 * has stopped, whatever TCP thinks.
 *
 * Ten minutes is also enough on the other side of the trade. The point of the
 * deadline is to turn *never* into *bounded* — an export nobody is reading used to
 * hold a socket, a suspended generator and an in-flight request that
 * `app.close()` waits on, for the life of the process. Bounding that at ten
 * minutes costs a stalled connection ten minutes of a socket; bounding it at two
 * costs a real payroll download its file, and the second failure is the one an
 * administrator cannot work around.
 *
 * Two things this deliberately does *not* rely on:
 *
 *  * Node's `server.requestTimeout` (30 s here). It bounds how long a client may
 *    take to **send** a request and stops counting once the request is complete —
 *    verified: exports of 132 s and 266 s completed untouched under it.
 *  * A final-flush allowance. `finish` fires when the last bytes reach the OS, not
 *    when the peer has them — measured with 2 MB still in flight, the response's
 *    `WROTE-ALL`, `finish` and `close` all landed inside the same 100 ms. The
 *    deadline is therefore already disarmed while the tail is delivered, so a
 *    nearly-complete download is never waiting on the peer with it still armed.
 */
export const EXPORT_STALL_TIMEOUT_MS = 600_000;

/**
 * How often progress is sampled.
 *
 * Coarse on purpose: this timer lives for the whole of every in-flight export,
 * and reading one counter twenty times over ten minutes costs nothing. The
 * consequence is that the effective deadline lands somewhere between
 * `EXPORT_STALL_TIMEOUT_MS` and one poll longer, which for a "this client has
 * clearly stopped" heuristic is not a distinction worth paying for.
 *
 * Twenty samples also means no single delayed timer decides the outcome, which a
 * two- or three-sample budget could not promise.
 */
export const EXPORT_STALL_POLL_MS = 30_000;

export interface ResponseDeadlineOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Called once, just before the response is destroyed. For logging. */
  onExpire?: () => void;
}

export interface ResponseDeadline {
  /** True once the deadline fired and destroyed the response. */
  readonly expired: boolean;
  /**
   * Records server-side progress.
   *
   * Called once per written batch. Without it the deadline would also fire on a
   * database that has gone slow — an export making real progress with nothing yet
   * to hand the socket — and blame the client for it. It cannot mask a stalled
   * client, because a stalled client parks the export inside `awaitDrain` before
   * the next batch is ever written, so no `touch` arrives either.
   */
  touch(): void;
  /** Disarms the deadline. Safe to call more than once. */
  clear(): void;
}

/**
 * Arms {@link EXPORT_STALL_TIMEOUT_MS} of no-progress on `response`.
 *
 * `socket.bytesWritten` is the progress signal because it is the only one that
 * reflects the *peer*. It counts bytes handed to the socket, and the export hands
 * over more only once the previous write has drained — which happens only when
 * the kernel, and therefore the client, has taken them. A client that has stopped
 * reading freezes it; a client trickling along advances it every drain.
 */
export function installResponseDeadline(
  response: DeadlineResponse,
  options: ResponseDeadlineOptions = {},
): ResponseDeadline {
  const { timeoutMs = EXPORT_STALL_TIMEOUT_MS, pollMs = EXPORT_STALL_POLL_MS, onExpire } = options;

  const idleLimit = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const progress = (): number => response.socket?.bytesWritten ?? 0;

  let seen = progress();
  let idle = 0;
  let expired = false;
  let timer: NodeJS.Timeout | null = null;

  const clear = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const touch = (): void => {
    idle = 0;
  };

  timer = setInterval(() => {
    // Already over — a completed or aborted response needs no deadline, and
    // destroying one twice is how a confusing second error gets logged.
    if (response.destroyed) {
      clear();
      return;
    }

    const written = progress();
    if (written !== seen) {
      seen = written;
      idle = 0;
      return;
    }

    idle += 1;
    if (idle < idleLimit) return;

    expired = true;
    clear();
    onExpire?.();
    // No error argument: there is nothing to deliver over a connection the peer
    // is not reading, and the export's own `catch` is what records the outcome.
    response.destroy();
  }, pollMs);

  // Never a reason to keep the process alive. A shutdown that is otherwise
  // finished must not wait three minutes for a timer whose only job is to give
  // up.
  timer.unref();

  return {
    get expired() {
      return expired;
    },
    touch,
    clear,
  };
}
