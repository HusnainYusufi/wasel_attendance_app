import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BodyAbortedError, PayloadTooLargeError, readBoundedBody } from '../raw-body.js';

describe('readBoundedBody', () => {
  it('concatenates every chunk in order', async () => {
    const stream = Readable.from([Buffer.from('abc'), Buffer.from('def')]);
    await expect(readBoundedBody(stream, 100)).resolves.toEqual(Buffer.from('abcdef'));
  });

  it('reads an empty body as an empty buffer rather than failing', async () => {
    // "Nothing was sent" is the caller's problem to report with a useful
    // message, not this reader's to conflate with a transport failure.
    const result = await readBoundedBody(Readable.from([]), 100);
    expect(result.byteLength).toBe(0);
  });

  it('accepts a body exactly at the limit', async () => {
    // Off-by-one here would refuse a legitimate upload at the boundary.
    const stream = Readable.from([Buffer.alloc(10, 1)]);
    await expect(readBoundedBody(stream, 10)).resolves.toHaveLength(10);
  });

  it('rejects one byte over the limit', async () => {
    const stream = Readable.from([Buffer.alloc(11, 1)]);
    await expect(readBoundedBody(stream, 10)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('rejects as soon as the running total crosses, not at the end', async () => {
    // Proves the cap is applied while reading. A reader that buffered everything
    // and measured afterwards would still "reject", having already spent the
    // memory the cap exists to protect.
    const stream = new PassThrough();
    const pending = readBoundedBody(stream, 8);

    stream.write(Buffer.alloc(5));
    stream.write(Buffer.alloc(5));

    await expect(pending).rejects.toBeInstanceOf(PayloadTooLargeError);
    // Never ended: the failure came from the size, not from end-of-stream.
    expect(stream.writableEnded).toBe(false);
  });

  it('reports the limit it enforced, so the message can state it', async () => {
    const error = await readBoundedBody(Readable.from([Buffer.alloc(20)]), 16).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect((error as PayloadTooLargeError).limitBytes).toBe(16);
  });

  it('drains rather than destroys an oversized upload', async () => {
    // Destroying the socket resets the connection, and the client sees
    // ECONNRESET instead of the 413 explaining what it did wrong.
    const stream = new PassThrough();
    const pending = readBoundedBody(stream, 4);
    stream.write(Buffer.alloc(10));

    await expect(pending).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(stream.destroyed).toBe(false);

    // The remainder is discarded without buffering, so a caller that keeps
    // sending cannot pin memory after being refused.
    expect(stream.write(Buffer.alloc(1_000))).toBe(true);
  });

  it('surfaces a transport error as an aborted body', async () => {
    const stream = new PassThrough();
    const pending = readBoundedBody(stream, 100);
    stream.destroy(new Error('ECONNRESET'));

    await expect(pending).rejects.toBeInstanceOf(BodyAbortedError);
  });

  it('treats a client that hangs up mid-body as aborted, not as a short read', async () => {
    // Resolving with the partial bytes here would store a truncated image and
    // report success for an upload that never finished.
    const stream = new PassThrough();
    const pending = readBoundedBody(stream, 100);
    stream.write(Buffer.from('half'));
    stream.destroy();

    await expect(pending).rejects.toBeInstanceOf(BodyAbortedError);
  });

  it('settles once, even when close follows end', async () => {
    // A stream emits `end` and then `close`; a reader that reacted to both would
    // reject an upload it had already resolved.
    const stream = new PassThrough();
    const pending = readBoundedBody(stream, 100);
    stream.end(Buffer.from('ok'));

    await expect(pending).resolves.toEqual(Buffer.from('ok'));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(pending).resolves.toEqual(Buffer.from('ok'));
  });

  it('handles a stream that yields strings', async () => {
    const stream = Readable.from(['a', 'b']);
    await expect(readBoundedBody(stream, 100)).resolves.toEqual(Buffer.from('ab'));
  });
});
