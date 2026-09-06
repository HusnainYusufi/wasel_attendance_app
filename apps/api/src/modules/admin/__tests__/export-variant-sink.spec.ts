import { Writable } from 'node:stream';
import { ExportVariant, type ReportSummary } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import type { ReportContext, ReportRange } from '../admin-reports.service.js';
import { createCsvSink } from '../export/csv-sink.js';
import { UTF8_BOM } from '../export/csv.js';
import { ClientDisconnectedError, type ExportSinkOptions } from '../export/export-sink.js';
import { createXlsxSink } from '../export/xlsx-sink.js';
import { reportRecord } from './fixtures.js';

/**
 * The properties the export path was audited for, exercised through the variant
 * that did not exist when it was audited.
 *
 * Both sinks are one implementation each, shared by both variants — which is the
 * whole reason the variant is a parameter and not a second writer. These tests
 * are what turn that from an intention into a fact: a future change that gives
 * one variant its own writer has to break them to do it.
 */

const CONTEXT: ReportContext = {
  organizationId: '33333333-3333-4333-8333-333333333333',
  organizationName: 'Acme Logistics',
  organizationSlug: 'acme-logistics',
  timezone: 'Asia/Riyadh',
};
const RANGE: ReportRange = { from: '2026-03-01', to: '2026-03-31', userId: undefined };
const SUMMARY: ReportSummary = {
  totalRecords: 1,
  presentCount: 1,
  lateCount: 0,
  incompleteCount: 0,
  distinctUsers: 1,
  totalWorkedMinutes: 496,
};

function options(stream: Writable, variant: ExportVariant): ExportSinkOptions {
  return {
    stream,
    context: CONTEXT,
    range: RANGE,
    generatedAt: new Date('2026-04-01T09:00:00.000Z'),
    timezoneChanges: [],
    variant,
  };
}

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

function collectingStream(chunks: string[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
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

describe.each([ExportVariant.DETAILED, ExportVariant.MINIFIED])('the %s CSV sheet', (variant) => {
  it('leads with the byte-order mark Excel needs to read a name as UTF-8', async () => {
    const chunks: string[] = [];
    const sink = createCsvSink(options(collectingStream(chunks), variant));

    await sink.writeBatch([
      reportRecord({
        user: { fullName: 'أحمد الغامدي', email: 'a@wasel.test', employeeCode: 'AR-1' },
      }),
    ]);

    expect(chunks[0]?.startsWith(UTF8_BOM)).toBe(true);
    expect(chunks.join('')).toContain('أحمد الغامدي');
  });

  it('neutralises a formula in a name whichever sheet it is written into', async () => {
    const chunks: string[] = [];
    const sink = createCsvSink(options(collectingStream(chunks), variant));

    await sink.writeBatch([
      reportRecord({
        user: { fullName: "=cmd|' /C calc'!A0", email: 'x@wasel.test', employeeCode: null },
      }),
    ]);

    expect(chunks.join('')).toContain("'=cmd|' /C calc'!A0");
  });

  it('waits for the socket rather than buffering into an unbounded queue', async () => {
    const stuck = stuckStream();
    const sink = createCsvSink(options(stuck, variant));

    // One batch is enough to overrun a 16-byte high-water mark, so the second
    // write is where a sink that ignores `write`'s return value would sail on.
    const pending = (async () => {
      for (;;) await sink.writeBatch([reportRecord()]);
    })();
    expect(await settled(pending)).toBe('pending');

    stuck.destroy();
    await expect(pending).rejects.toBeInstanceOf(ClientDisconnectedError);
  });
});

describe.each([ExportVariant.DETAILED, ExportVariant.MINIFIED])('the %s workbook', (variant) => {
  /**
   * The bug this whole discipline exists for, checked on both sheets.
   *
   * ExcelJS renders into its own `StreamBuf`, whose `write()` returns `true`
   * unconditionally and appends to an unbounded array — so a writer that trusts
   * the encoder pulls the entire range into memory while the client has received
   * a few hundred kilobytes. `writeBatch` must therefore park on the *socket*.
   */
  it('holds the producer while the client is behind', async () => {
    const stuck = stuckStream();
    const sink = createXlsxSink(options(stuck, variant));

    const pending = sink.writeBatch(Array.from({ length: 50 }, () => reportRecord()));
    expect(await settled(pending)).toBe('pending');

    stuck.destroy();
    await expect(pending).rejects.toBeInstanceOf(ClientDisconnectedError);
  });

  it('refuses to finish a workbook the client has already dropped', async () => {
    const stuck = stuckStream();
    const sink = createXlsxSink(options(stuck, variant));
    stuck.destroy();

    await expect(sink.finish(SUMMARY)).rejects.toBeInstanceOf(ClientDisconnectedError);
  });
});
