import type { Readable } from 'node:stream';

/**
 * A size-bounded reader for a request body nothing else has parsed.
 *
 * The avatar upload is a `PUT` whose body is the image itself, so no body parser
 * touches it: `bodyParser.json` and `bodyParser.urlencoded` both match on
 * `Content-Type` and step aside for `image/*`. The stream therefore arrives at
 * the handler untouched, and this is what consumes it.
 *
 * Kept free of Express and Nest so the interesting behaviour — the cap, the
 * drain, the aborted client — is unit-testable against a plain `Readable`.
 */

/** Raised when a body exceeds its cap. Carries the cap so the message can state it. */
export class PayloadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Request body exceeded ${limitBytes} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

/** Raised when the client hung up before the body finished arriving. */
export class BodyAbortedError extends Error {
  constructor(cause?: unknown) {
    super('The request body was not fully received');
    this.name = 'BodyAbortedError';
    this.cause = cause;
  }
}

/**
 * Reads the whole stream into one buffer, refusing to exceed `limitBytes`.
 *
 * Two details are load-bearing:
 *
 *  * **The accumulated chunks are dropped the moment the cap is crossed.** The
 *    point of a cap is to bound memory; holding on to what was already read
 *    while rejecting would let a caller pin exactly `limitBytes` per concurrent
 *    request for as long as the promise chain takes to unwind.
 *
 *  * **The stream is drained, not destroyed.** Destroying an incoming socket
 *    mid-upload resets the connection, and the client sees `ECONNRESET` instead
 *    of the 413 explaining what it did wrong — which is precisely the
 *    "unhandled 413" this endpoint is supposed to avoid. `resume()` discards the
 *    remainder cheaply; `server.requestTimeout` (30 s) bounds how long a hostile
 *    client can make us do that for.
 */
export function readBoundedBody(stream: Readable, limitBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      chunks = [];
      cleanup();
      reject(error);
    };

    const succeed = (value: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    function onData(chunk: Buffer | string): void {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buffer.length;
      if (total > limitBytes) {
        fail(new PayloadTooLargeError(limitBytes));
        // After `cleanup` there is no `data` listener, so flowing mode discards
        // the rest of the upload instead of buffering it.
        stream.resume();
        return;
      }
      chunks.push(buffer);
    }

    function onEnd(): void {
      succeed(Buffer.concat(chunks, total));
    }

    function onError(error: unknown): void {
      fail(new BodyAbortedError(error));
    }

    /**
     * `close` fires for both a clean end and an aborted request. Only the second
     * is interesting, and `readableEnded` is what tells them apart — without it
     * every successful upload would race its own `end` handler.
     */
    function onClose(): void {
      if (!stream.readableEnded) fail(new BodyAbortedError());
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}
