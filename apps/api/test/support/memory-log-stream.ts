import type { DestinationStream } from 'pino';

export interface LogRecord {
  level: number;
  msg?: string;
  [key: string]: unknown;
}

export interface MemoryLogStream extends DestinationStream {
  /** Every line written, parsed. Non-JSON lines are ignored. */
  records(): LogRecord[];
  /** The raw bytes, for assertions of the form "this string never appeared". */
  raw(): string;
  clear(): void;
  /**
   * Waits for a matching line, then returns everything written.
   *
   * pino-http writes its request line from the response's `finish` event, which
   * fires after supertest's promise settles. Asserting immediately is a race —
   * and it fails *open*, because "the log does not contain the secret" is
   * trivially true of a log that is still empty.
   */
  waitFor(match: (record: LogRecord) => boolean, timeoutMs?: number): Promise<LogRecord[]>;
}

/**
 * Collects pino output in memory.
 *
 * Assertions run against the bytes pino would really have written, so a test that
 * claims "the password never reaches the log" is checking the serialised,
 * redacted output rather than a mock of the logger — which would prove nothing
 * about redaction.
 */
export function createMemoryLogStream(): MemoryLogStream {
  let buffer = '';

  const parse = (): LogRecord[] =>
    buffer
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LogRecord];
        } catch {
          return [];
        }
      });

  return {
    write(chunk: string): void {
      buffer += chunk;
    },
    records(): LogRecord[] {
      return parse();
    },
    async waitFor(match: (record: LogRecord) => boolean, timeoutMs = 2_000): Promise<LogRecord[]> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const records = parse();
        if (records.some(match)) return records;
        if (Date.now() >= deadline) {
          throw new Error(
            `No log line matched within ${timeoutMs}ms. Wrote ${records.length} line(s).`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    raw(): string {
      return buffer;
    },
    clear(): void {
      buffer = '';
    },
  };
}
