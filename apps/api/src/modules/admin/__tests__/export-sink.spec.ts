import { createServer, type Server, type ServerResponse } from 'node:http';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPORT_MAX_XLSX_ROWS } from '../admin.constants.js';
import {
  ClientDisconnectedError,
  assertClientPresent,
  awaitBackpressure,
  endStream,
  untilClosed,
  writeChunk,
} from '../export/export-sink.js';
import { assertXlsxRowLimit } from '../export/xlsx-sink.js';

/** A socket that accepts one high-water mark and then never drains again. */
function stuckStream(): Writable {
  return new Writable({
    highWaterMark: 16,
    write(_chunk, _encoding, _callback) {
      // Deliberately never calls back: the queue fills, `write` returns false,
      // and `drain` will not arrive until someone destroys the stream.
    },
  });
}

const settled = async <T>(promise: Promise<T>): Promise<'pending' | 'resolved' | 'rejected'> => {
  const marker = Symbol('pending');
  const outcome = await Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), 150)),
  ]);
  return outcome === marker ? 'pending' : outcome;
};

describe('writeChunk', () => {
  it('resolves without waiting when the consumer keeps up', async () => {
    const chunks: string[] = [];
    const fast = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    await writeChunk(fast, 'hello');
    expect(chunks).toEqual(['hello']);
  });

  it('waits for drain when the consumer is behind', async () => {
    let release: (() => void) | undefined;
    const slow = new Writable({
      highWaterMark: 8,
      write(_chunk, _encoding, callback) {
        release = () => callback();
      },
    });

    const first = writeChunk(slow, 'aaaaaaaaaaaaaaaa');
    expect(await settled(first)).toBe('pending');

    release?.();
    await first;
  });

  /**
   * The leak the whole export path used to have.
   *
   * `await once(stream, 'drain')` on a destroyed `ServerResponse` never settles:
   * the socket emits `close`, never `drain`, and never `error`. The generator
   * suspended on it, the last 500-row batch, the sink and the response therefore
   * stayed reachable for the life of the process — and an in-flight request that
   * never completes is exactly what a rolling deploy waits on.
   */
  it('rejects rather than hanging when the client disconnects mid-write', async () => {
    const stuck = stuckStream();
    const pending = writeChunk(stuck, 'x'.repeat(64));
    expect(await settled(pending)).toBe('pending');

    stuck.destroy();
    await expect(pending).rejects.toBeInstanceOf(ClientDisconnectedError);
  });

  it('refuses to write to a stream the client already dropped', async () => {
    const stuck = stuckStream();
    stuck.destroy();
    await expect(writeChunk(stuck, 'x')).rejects.toBeInstanceOf(ClientDisconnectedError);
  });
});

describe('awaitBackpressure', () => {
  it('returns promptly while the socket is empty', async () => {
    const fast = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    await expect(awaitBackpressure(fast)).resolves.toBeUndefined();
  });

  /**
   * The producer must be held even though it never called `write` itself — this
   * is the case ExcelJS creates, where the rows go into a third-party buffer and
   * the only visible signal is the socket's own appetite.
   */
  it('holds the producer while the socket is full', async () => {
    const stuck = stuckStream();
    // Fill the queue the way the encoder would, without the producer's knowledge.
    stuck.write('x'.repeat(64));
    expect(stuck.writableNeedDrain).toBe(true);

    const pending = awaitBackpressure(stuck);
    expect(await settled(pending)).toBe('pending');

    stuck.destroy();
    await expect(pending).rejects.toBeInstanceOf(ClientDisconnectedError);
  });
});

describe('assertClientPresent', () => {
  it('accepts a live stream and rejects a destroyed or ended one', () => {
    const live = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    expect(() => assertClientPresent(live)).not.toThrow();

    live.destroy();
    expect(() => assertClientPresent(live)).toThrow(ClientDisconnectedError);
  });
});

describe('untilClosed', () => {
  it('yields the work when it finishes first', async () => {
    const live = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    await expect(untilClosed(live, Promise.resolve('done'))).resolves.toBe('done');
  });

  it('gives up when the client closes first', async () => {
    const stuck = stuckStream();
    // `WorkbookWriter.commit()` settles on the response's `finish`, which a
    // destroyed socket cannot emit.
    const never = new Promise<void>(() => {});
    const pending = untilClosed(stuck, never);

    stuck.destroy();
    await expect(pending).rejects.toBeInstanceOf(ClientDisconnectedError);
  });
});

describe('endStream', () => {
  it('resolves once the stream has finished', async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    await expect(endStream(sink)).resolves.toBeUndefined();
  });

  it('settles when a destroyed stream closes without finishing', async () => {
    const stuck = stuckStream();
    stuck.write('x'.repeat(64));
    const pending = endStream(stuck);
    stuck.destroy();
    await expect(pending).rejects.toBeInstanceOf(ClientDisconnectedError);
  });
});

/**
 * The same primitives against a real `http.ServerResponse`, because the shape of
 * the bug was specific to one: an aborted request destroys the socket, and the
 * events a plain `Writable` emits are not automatically the events that arrive.
 */
describe('against a real ServerResponse', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('settles the handler when the client aborts mid-response', async () => {
    let handlerOutcome: unknown = 'still pending';

    const done = new Promise<void>((resolve) => {
      server.once('request', (_request, response: ServerResponse) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        void (async () => {
          try {
            for (;;) await writeChunk(response, 'x'.repeat(64 * 1024));
          } catch (error) {
            handlerOutcome = error;
          } finally {
            resolve();
          }
        })();
      });
    });

    const request = get({ port, path: '/' }, (response) => {
      response.once('data', () => request.destroy());
    });
    await done;

    expect(handlerOutcome).toBeInstanceOf(ClientDisconnectedError);
  });
});

describe('assertXlsxRowLimit', () => {
  it('accepts any range up to a worksheet full of rows', () => {
    expect(() => assertXlsxRowLimit(0)).not.toThrow();
    expect(() => assertXlsxRowLimit(EXPORT_MAX_XLSX_ROWS)).not.toThrow();
  });

  /**
   * One row past the ceiling is not a big download, it is a file Excel refuses to
   * open — so it is refused with a `400` that names the remedy, before the first
   * byte, while there is still an error envelope to put it in.
   */
  it('refuses one row past the worksheet ceiling', () => {
    expect(() => assertXlsxRowLimit(EXPORT_MAX_XLSX_ROWS + 1)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});
