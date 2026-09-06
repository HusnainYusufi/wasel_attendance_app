import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { loadAppConfig } from '../../../config/app-config.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { buildPinoHttpOptions, censorUrl } from '../pino-options.js';
import { REDACTED_FIELDS, REDACTION_PLACEHOLDER } from '../redaction.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
  JWT_ACCESS_SECRET: 'unit-access-secret-4f2b9c1e-not-for-real-signing',
  JWT_REFRESH_SECRET: 'unit-refresh-secret-7a1d6e3b-not-for-real-signing',
  LOG_LEVEL: 'debug',
} satisfies NodeJS.ProcessEnv;

function configService(overrides: NodeJS.ProcessEnv = {}): AppConfigService {
  return new AppConfigService(loadAppConfig({ ...BASE_ENV, ...overrides }));
}

interface Harness {
  /** The pino instance pino-http built — wrapped serialisers and all. */
  logger: Logger;
  /** Drives one request/response cycle through the middleware. */
  request: (options?: FakeRequestOptions) => void;
  output: () => string;
  records: () => Array<Record<string, unknown>>;
}

interface FakeRequestOptions {
  url?: string;
  headers?: Record<string, string | string[]>;
  remoteAddress?: string;
  statusCode?: number;
  responseHeaders?: Record<string, string | string[]>;
}

/**
 * Builds the middleware exactly as `LoggingModule` does, then drives a request
 * through it.
 *
 * Calling `options.serializers.req` directly would test a function production
 * never calls with that argument: pino-http wraps every custom serialiser in
 * `pino-std-serializers`' `wrapRequestSerializer`, which flattens the raw
 * `IncomingMessage` first. A test that hand-feeds `{ socket: { remoteAddress } }`
 * therefore passes while the shipped code logs `undefined`.
 */
function harness(overrides: NodeJS.ProcessEnv = {}): Harness {
  let buffer = '';
  const stream = { write: (chunk: string) => void (buffer += chunk) };
  const middleware = pinoHttp(buildPinoHttpOptions(configService(overrides)), stream);

  const output = (): string => buffer;
  const records = (): Array<Record<string, unknown>> =>
    buffer
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    logger: middleware.logger,
    output,
    records,
    request: (options: FakeRequestOptions = {}) => {
      const url = options.url ?? '/api/v1/auth/login';
      const req = {
        method: 'POST',
        url,
        originalUrl: url,
        headers: options.headers ?? {},
        socket: { remoteAddress: options.remoteAddress ?? '10.0.0.1', remotePort: 51234 },
      } as unknown as IncomingMessage;

      const res = new EventEmitter() as unknown as ServerResponse;
      Object.assign(res, {
        statusCode: options.statusCode ?? 200,
        headersSent: true,
        setHeader: () => undefined,
        getHeaders: () => options.responseHeaders ?? { 'set-cookie': 'sid=leaked-cookie-value' },
      });

      middleware(req, res);
      res.emit('finish');
    },
  };
}

describe('redaction depth', () => {
  it.each(REDACTED_FIELDS)('redacts a top-level %s', (field) => {
    const { logger, output } = harness();
    logger.info({ [field]: 'sensitive-value' }, 'message');

    expect(output()).not.toContain('sensitive-value');
    expect(output()).toContain(REDACTION_PLACEHOLDER);
  });

  it.each(REDACTED_FIELDS)('redacts %s one level down', (field) => {
    const { logger, output } = harness();
    logger.info({ user: { [field]: 'sensitive-value' } }, 'message');

    expect(output()).not.toContain('sensitive-value');
  });

  it.each(REDACTED_FIELDS)('redacts %s two levels down', (field) => {
    const { logger, output } = harness();
    logger.info({ auth: { user: { [field]: 'sensitive-value' } } }, 'message');

    expect(output()).not.toContain('sensitive-value');
  });

  it('redacts a secret inside a list of rows', () => {
    // The admin export path logs lists of rows; `{ users: [{ password }] }` is
    // already two levels deep, which a single `*.` wildcard never reaches.
    const { logger, output } = harness();
    logger.info(
      {
        users: [
          { id: 'u-1', passwordHash: 'argon2id$leaked-hash-1' },
          { id: 'u-2', passwordHash: 'argon2id$leaked-hash-2' },
        ],
      },
      'exporting users',
    );

    expect(output()).not.toContain('leaked-hash-1');
    expect(output()).not.toContain('leaked-hash-2');
    expect(output()).toContain('u-2');
  });

  it('redacts a secret nested inside an array inside an object', () => {
    const { logger, output } = harness();
    logger.info({ page: { rows: [{ session: { refreshToken: 'rt-deep-value' } }] } }, 'message');

    expect(output()).not.toContain('rt-deep-value');
  });

  it.each([
    ['Authorization', 'Bearer capitalised-secret'],
    ['ACCESS_TOKEN', 'screaming-snake-secret'],
    ['Refresh-Token', 'hyphenated-secret'],
    ['passwordhash', 'lowercase-run-together-secret'],
  ])('redacts %s whatever its casing or separators', (field, value) => {
    const { logger, output } = harness();
    logger.info({ headers: { [field]: value } }, 'message');

    expect(output()).not.toContain(value);
  });

  it('redacts a context object attached to a thrown error', () => {
    const { logger, output, records } = harness();
    const error = Object.assign(new Error('token exchange failed'), {
      ctx: { userId: 'u-1', refreshToken: 'rt-inside-error' },
    });

    logger.error({ err: error }, 'request failed');

    expect(output()).not.toContain('rt-inside-error');
    // The rest of the error must survive the censoring copy.
    const err = records()[0]?.['err'] as Record<string, unknown>;
    expect(err['message']).toBe('token exchange failed');
    expect(err['stack']).toEqual(expect.stringContaining('Error: token exchange failed'));
    expect((err['ctx'] as Record<string, unknown>)['userId']).toBe('u-1');
  });

  it('terminates on a self-referential record', () => {
    const { logger, output } = harness();
    const node: Record<string, unknown> = { password: 'cyclic-secret' };
    node['self'] = node;

    logger.info({ node }, 'message');

    expect(output()).not.toContain('cyclic-secret');
  });

  it('leaves non-secret fields legible and the record untouched by identity', () => {
    const { logger, output } = harness();
    const record = { userId: 'u-1', organizationId: 'o-1' };
    logger.info(record, 'context');

    expect(output()).toContain('u-1');
    expect(output()).toContain('o-1');
    // Nothing was censored, so nothing was copied — and the caller's object is
    // never mutated in either case.
    expect(record).toEqual({ userId: 'u-1', organizationId: 'o-1' });
  });

  it('does not mutate the caller object it censors', () => {
    const { logger } = harness();
    const record = { user: { password: 'still-mine' } };
    logger.info(record, 'context');

    expect(record.user.password).toBe('still-mine');
  });
});

describe('censorUrl', () => {
  it.each([
    ['/x?token=SECRET', 'token'],
    ['/x?access_token=SECRET', 'access_token'],
    ['/x?refresh_token=SECRET', 'refresh_token'],
    ['/x?password=SECRET', 'password'],
    ['/x?code=SECRET', 'code'],
    ['/x?secret=SECRET', 'secret'],
    ['/x?key=SECRET', 'key'],
    ['/x?Token=SECRET', 'Token (capitalised)'],
  ])('censors %s (%s)', (url) => {
    const censored = censorUrl(url);
    expect(censored).not.toContain('SECRET');
    expect(censored).toContain(REDACTION_PLACEHOLDER);
  });

  it('keeps the path and the harmless parameters verbatim', () => {
    expect(censorUrl('/api/v1/x?page=2&token=SECRET&pageSize=50')).toBe(
      `/api/v1/x?page=2&token=${REDACTION_PLACEHOLDER}&pageSize=50`,
    );
  });

  it('returns a URL with nothing to censor by identity', () => {
    const url = '/api/v1/attendance?page=2';
    expect(censorUrl(url)).toBe(url);
    expect(censorUrl('/api/v1/attendance')).toBe('/api/v1/attendance');
  });

  it('censors a parameter that appears after a fragment marker only once', () => {
    expect(censorUrl('https://x.test/cb?code=SECRET#state=abc')).toBe(
      `https://x.test/cb?code=${REDACTION_PLACEHOLDER}#state=abc`,
    );
  });
});

describe('request serialisation through pino-http', () => {
  function requestRecord(options: FakeRequestOptions): Record<string, unknown> {
    const h = harness();
    h.request(options);
    const record = h.records()[0];
    if (!record) throw new Error('no log line was written');
    return record['req'] as Record<string, unknown>;
  }

  it('records the peer address the wrapper flattened onto the request', () => {
    // `wrapRequestSerializer` hands the custom serialiser an already-serialised
    // record with no `socket`, so `req.socket?.remoteAddress` is always undefined
    // in production even though it reads perfectly.
    expect(requestRecord({ remoteAddress: '203.0.113.9' })['remoteAddress']).toBe('203.0.113.9');
  });

  it('records the method and url', () => {
    expect(requestRecord({ url: '/api/v1/attendance/check-in' })).toMatchObject({
      method: 'POST',
      url: '/api/v1/attendance/check-in',
    });
  });

  it('censors secrets carried in the query string', () => {
    const h = harness();
    h.request({
      url: '/api/v1/x?token=SUPER_SECRET&password=PLAINTEXT_PW&access_token=AT_SECRET&page=2',
    });

    const raw = h.output();
    expect(raw).not.toContain('SUPER_SECRET');
    expect(raw).not.toContain('PLAINTEXT_PW');
    expect(raw).not.toContain('AT_SECRET');
    expect(raw).toContain('page=2');
  });

  it('censors secrets carried in the Referer header', () => {
    const h = harness();
    h.request({ headers: { referer: 'https://evil.test/?token=REFERER_TOKEN' } });

    expect(h.output()).not.toContain('REFERER_TOKEN');
    expect(h.output()).toContain('evil.test');
  });

  it('keeps only allowlisted headers', () => {
    const headers = requestRecord({
      headers: {
        'user-agent': 'vitest',
        'x-internal-secret': 'leak-me',
        authorization: 'Bearer leaked-bearer',
        cookie: 'sid=leaked-cookie',
      },
    })['headers'] as Record<string, unknown>;

    expect(headers).toEqual({ 'user-agent': 'vitest' });
  });

  it('never includes the request body, the query object or the route params', () => {
    const record = requestRecord({ url: '/api/v1/x?page=2' });
    expect(record).not.toHaveProperty('body');
    expect(record).not.toHaveProperty('query');
    expect(record).not.toHaveProperty('params');
  });
});

describe('response serialisation through pino-http', () => {
  it('records the status code and no response headers at all', () => {
    const h = harness();
    h.request({ statusCode: 201, responseHeaders: { 'set-cookie': 'sid=leaked-cookie-value' } });

    const record = h.records()[0];
    expect(record?.['res']).toEqual({ statusCode: 201 });
    expect(h.output()).not.toContain('leaked-cookie-value');
  });
});

describe('request ids and log levels', () => {
  function optionsFor(overrides: NodeJS.ProcessEnv = {}) {
    return buildPinoHttpOptions(configService(overrides));
  }

  it('echoes the resolved request id on the response', () => {
    const headers = new Map<string, string>();
    const res = {
      setHeader: (k: string, v: string) => headers.set(k, v),
    } as unknown as ServerResponse;
    const req = { headers: { 'x-request-id': 'inbound-7' } } as unknown as IncomingMessage;

    const id = optionsFor().genReqId?.(req, res);

    expect(id).toBe('inbound-7');
    expect(headers.get('x-request-id')).toBe('inbound-7');
  });

  it.each([
    [200, 'info'],
    [301, 'info'],
    [404, 'warn'],
    [429, 'warn'],
    [500, 'error'],
  ])('logs status %i at %s', (statusCode, expected) => {
    const level = optionsFor().customLogLevel?.(
      {} as IncomingMessage,
      { statusCode } as ServerResponse,
      undefined,
    );
    expect(level).toBe(expected);
  });

  it('logs at error level when the handler threw, whatever the status', () => {
    const level = optionsFor().customLogLevel?.(
      {} as IncomingMessage,
      { statusCode: 200 } as ServerResponse,
      new Error('boom'),
    );
    expect(level).toBe('error');
  });

  it.each(['/api/v1/health/live', '/api/v1/health/ready', '/api/v1/health/live?probe=1'])(
    'suppresses the %s probe',
    (url) => {
      const autoLogging = optionsFor().autoLogging;
      const ignore =
        typeof autoLogging === 'object' && autoLogging !== null ? autoLogging.ignore : undefined;
      expect(ignore?.({ url } as IncomingMessage)).toBe(true);
    },
  );

  it('does not suppress ordinary routes', () => {
    const autoLogging = optionsFor().autoLogging;
    const ignore =
      typeof autoLogging === 'object' && autoLogging !== null ? autoLogging.ignore : undefined;
    expect(ignore?.({ url: '/api/v1/attendance/check-in' } as IncomingMessage)).toBe(false);
  });

  it('only configures the pretty transport where a human reads the output', () => {
    expect(optionsFor({ NODE_ENV: 'development' }).transport).toBeDefined();
    expect(optionsFor({ NODE_ENV: 'production' }).transport).toBeUndefined();
    expect(optionsFor({ NODE_ENV: 'test' }).transport).toBeUndefined();
  });
});
