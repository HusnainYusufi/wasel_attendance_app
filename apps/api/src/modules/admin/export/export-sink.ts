import type { Writable } from 'node:stream';
import { once } from 'node:events';
import type { ExportVariant, ReportSummary } from '@wasel/contracts';
import type { ReportRecord } from '../admin.mapper.js';
import type { ReportContext, ReportRange, TimezoneChange } from '../admin-reports.service.js';

/**
 * A destination for an attendance export.
 *
 * Batch-at-a-time rather than row-at-a-time, and streaming rather than
 * buffering: the export is capped by `EXPORT_MAX_RANGE_DAYS` in *days*, which
 * says nothing about rows. A year for a 400-person organization is ~100k
 * records; rendering that into a string or a `Buffer` before the first byte
 * leaves the process is how one download takes the API down for everyone else.
 *
 * `writeBatch` returns a promise for one reason only: it is where the producer
 * yields to the consumer. A sink that resolves immediately is not streaming, it
 * is buffering somewhere the caller cannot see — see {@link awaitBackpressure}.
 */
export interface ExportSink {
  writeBatch(records: readonly ReportRecord[]): Promise<void>;
  /** Writes any trailer and ends the underlying stream. */
  finish(summary: ReportSummary): Promise<void>;
}

export interface ExportSinkOptions {
  stream: Writable;
  context: ReportContext;
  range: ReportRange;
  generatedAt: Date;
  /**
   * Which sheet to build — see `export-sheet.ts`.
   *
   * The variant travels in the options rather than being baked into a sink
   * factory per variant, so there stays exactly one CSV writer and one XLSX
   * writer. The properties this file exists to guarantee — a write that respects
   * the socket, a drain that gives up when the client does — are then impossible
   * to have in one variant and not the other.
   */
  variant: ExportVariant;
  /**
   * Timezone moves recorded on or after the range's first day, oldest first.
   *
   * Empty for almost every export ever taken. When it is not, the file must say
   * so: `workDate` is frozen at punch time but every instant in the sheet is
   * rendered in the tenant's *current* zone, so these rows are the difference
   * between a sheet that quietly contradicts itself and one that explains why.
   */
  timezoneChanges: readonly TimezoneChange[];
}

/**
 * The client hung up part-way through a download.
 *
 * A distinct type because it is not a fault: a cancelled download is an ordinary
 * thing for a browser to do, and the export path has to tell it apart from a
 * database or rendering failure so the first is logged as a warning and the
 * second as an error. It also has to be *thrown*, so that the `for await` loop
 * unwinds into the handler's `catch` instead of hanging on a promise the dead
 * socket will never settle.
 */
export class ClientDisconnectedError extends Error {
  constructor(message = 'The client disconnected before the export finished') {
    super(message);
    this.name = 'ClientDisconnectedError';
  }
}

/** Throws {@link ClientDisconnectedError} if there is no longer anyone to write to. */
export function assertClientPresent(stream: Writable): void {
  if (stream.destroyed || stream.writableEnded) throw new ClientDisconnectedError();
}

/**
 * Waits for the stream to ask for more data, or gives up when the client goes.
 *
 * The `close` listener is the whole point. A bare `await once(stream, 'drain')`
 * on a destroyed `ServerResponse` **never settles**: an aborted socket emits
 * `close`, never `drain`, and never `error` — so the promise, the generator
 * suspended on it, the last batch and the sink all stay reachable for the life of
 * the process, and the request stays in flight for anything waiting on
 * `app.close()`. Aborting the wait converts a permanent leak into an exception
 * the caller already knows how to handle.
 */
export async function awaitDrain(stream: Writable): Promise<void> {
  const abort = new AbortController();
  const onClose = (): void => abort.abort();
  stream.once('close', onClose);

  try {
    await once(stream, 'drain', { signal: abort.signal });
  } catch (error) {
    if (abort.signal.aborted) throw new ClientDisconnectedError();
    throw error;
  } finally {
    stream.off('close', onClose);
  }
}

/**
 * Writes a chunk, waiting for `drain` when the socket is full.
 *
 * Ignoring `write`'s return value is what turns "streaming" back into
 * "buffering": Node keeps accepting chunks into an unbounded internal queue, so
 * a slow client silently pins the whole export in memory anyway.
 */
export async function writeChunk(stream: Writable, chunk: string): Promise<void> {
  assertClientPresent(stream);
  if (stream.write(chunk)) return;
  await awaitDrain(stream);
}

/**
 * Turns the socket must stay empty before the producer is allowed on again.
 *
 * One is not enough: a `drain` frees buffer space, but the encoder resumes
 * writing into it asynchronously, so the very next turn can find an empty socket
 * simply because the backlog has not been re-offered yet. Requiring consecutive
 * quiet turns waits out that window instead of reading it as "the client has
 * caught up".
 */
const QUIET_TURNS = 3;

/**
 * Drains the socket for a producer that does not write to it itself.
 *
 * {@link writeChunk} can consult `write`'s return value because it owns the
 * write. A writer that hands its rows to a third-party encoder cannot: ExcelJS
 * renders into its own `StreamBuf`, whose `write()` returns `true` unconditionally
 * and appends to an unbounded array, so nothing the socket does is visible to the
 * code adding rows. The socket's own appetite is the only honest signal left.
 *
 * Both halves of the loop are load-bearing.
 *
 * The `setImmediate` is not a courtesy. Rendering a batch is synchronous; the
 * bytes it produces reach the socket a turn or more later, through the encoder's
 * queues and the deflate thread. Reading `writableNeedDrain` in the same tick
 * therefore inspects a queue nothing has been put into yet, and always answers
 * "keep going".
 *
 * Waiting for a *single* drain is not enough either, and measurably so: a drain
 * frees one high-water mark of socket buffer, the encoder refills it on the next
 * turn, and a producer that returned after one drain simply races ahead again —
 * 45 of 74 batches of a throttled export still went out in the first eight
 * seconds. Looping until a turn passes with the socket **not** full is what
 * empties the encoder's backlog before the next batch is rendered, and it
 * terminates on its own: the only thing feeding that backlog is the caller, and
 * the caller is here, waiting.
 *
 * A client that keeps up never sees any of this — the first turn finds an empty
 * socket buffer and returns.
 */
export async function awaitBackpressure(stream: Writable): Promise<void> {
  let quiet = 0;
  while (quiet < QUIET_TURNS) {
    assertClientPresent(stream);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertClientPresent(stream);

    if (stream.writableNeedDrain) {
      quiet = 0;
      await awaitDrain(stream);
    } else {
      quiet += 1;
    }
  }
}

/**
 * Awaits `work`, but gives up the moment the client goes away.
 *
 * For the encoder's own "I have flushed everything" promise, which ExcelJS
 * settles on the response's `finish` event — an event a destroyed socket cannot
 * emit, so without this race the last await of an aborted export hangs for the
 * life of the process.
 */
export async function untilClosed<T>(stream: Writable, work: Promise<T>): Promise<T> {
  let onClose: (() => void) | undefined;
  const disconnected = new Promise<never>((_resolve, reject) => {
    onClose = (): void => reject(new ClientDisconnectedError());
    stream.once('close', onClose);
  });
  // Exactly one of the two settles this call; the loser may still reject later
  // with nobody listening, which Node reports as an unhandled rejection.
  const ignore = (): void => {};
  work.catch(ignore);
  disconnected.catch(ignore);

  try {
    return await Promise.race([work, disconnected]);
  } finally {
    if (onClose !== undefined) stream.off('close', onClose);
  }
}

/**
 * Ends the stream and resolves once the last byte has been flushed.
 *
 * Waits on `finish` rather than passing a callback to `end`. The response has
 * been wrapped by the `compression` middleware, whose `end` implements only the
 * `(chunk, encoding, callback)` overload — hand it `end(callback)` and it tries
 * to turn the function into a Buffer and throws mid-response, which surfaces as
 * a socket hang-up rather than as anything that names the cause.
 *
 * `close` is listened for alongside `finish` for the reason given on
 * {@link awaitDrain}: an aborted socket emits only `close`, and a promise that
 * waits for a `finish` which can no longer happen is a leak, not a wait.
 */
export function endStream(stream: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      stream.off('error', onError);
      stream.off('finish', onFinish);
      stream.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => {
      settle(error);
    };
    const onFinish = (): void => {
      settle();
    };
    const onClose = (): void => {
      settle(stream.writableFinished ? undefined : new ClientDisconnectedError());
    };

    stream.once('error', onError);
    stream.once('finish', onFinish);
    stream.once('close', onClose);
    stream.end();
  });
}
