import compression from 'compression';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoNestLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from './config/app-config.service.js';
import {
  createFinalErrorHandler,
  createNotFoundHandler,
} from './common/filters/fallback-handlers.js';
import { API_GLOBAL_PREFIX } from './common/http/api-prefix.js';
import { createCorsOptions, createVaryOriginHandler } from './common/http/cors.js';
import { createSecurityHeaders } from './common/http/security-headers.js';
import { setupSwagger } from './common/openapi/setup-swagger.js';

export const GLOBAL_PREFIX = API_GLOBAL_PREFIX;

/**
 * How long a client has to finish sending a request.
 *
 * Node's default is 300 seconds, which is 300 seconds a single slow client can
 * hold a worker and — because an in-flight request blocks a graceful shutdown —
 * 300 seconds it can hold a rolling deploy. Attendance payloads are a few hundred
 * bytes; anything that cannot arrive in thirty seconds is not a real client.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Headers alone must arrive far sooner than the whole request. */
const HEADERS_TIMEOUT_MS = 15_000;

/**
 * How long `app.close()` is given before the process is killed anyway.
 *
 * Shorter than any sane orchestrator grace period (Kubernetes defaults to 30 s),
 * so the *process* decides to give up rather than being SIGKILLed. That
 * distinction matters: a SIGKILL skips `onModuleDestroy`, so `$disconnect()`
 * never runs and Postgres holds the pool open while the replacement pod opens its
 * own — connection exhaustion at the worst possible moment.
 */
export const SHUTDOWN_DEADLINE_MS = 10_000;

export interface ConfiguredApp {
  /** Where Swagger UI was mounted, or null when documentation is disabled. */
  swaggerPath: string | null;
}

export interface ShutdownDeadlineOptions {
  deadlineMs?: number;
  exit?: (code: number) => void;
  /** Injected so the deadline is testable without raising a real signal. */
  signals?: Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>;
}

/**
 * Arms a hard deadline on the first termination signal.
 *
 * `enableShutdownHooks` drains in-flight requests, which is right up to the point
 * where a request will not drain — a client trickling one byte a second keeps the
 * socket, and therefore the shutdown, alive indefinitely. The timer is `unref`ed
 * so it never keeps an otherwise-finished process alive: a shutdown that does
 * complete exits on its own, well before the deadline.
 */
export function installShutdownDeadline(options: ShutdownDeadlineOptions = {}): () => void {
  const {
    deadlineMs = SHUTDOWN_DEADLINE_MS,
    exit = (code: number) => process.exit(code),
    signals = process,
  } = options;

  let armed = false;

  const arm = (): void => {
    if (armed) return;
    armed = true;
    setTimeout(() => exit(1), deadlineMs).unref();
  };

  signals.on('SIGTERM', arm);
  signals.on('SIGINT', arm);

  return () => {
    signals.removeListener('SIGTERM', arm);
    signals.removeListener('SIGINT', arm);
  };
}

/**
 * Applies every cross-cutting concern and initialises the application.
 *
 * Shared verbatim between `main.ts` and the integration test harness. If tests
 * assembled their own pipeline they would be testing a different application
 * than the one that ships — most obviously they would miss the global prefix, the
 * CORS policy and the body-size limit, which is where the interesting bugs are.
 */
export async function configureApp(app: NestExpressApplication): Promise<ConfiguredApp> {
  const config = app.get(AppConfigService);

  app.useLogger(app.get(PinoNestLogger));
  app.flushLogs();

  // A hop count, never `true`: with `true` Express takes the left-most
  // `X-Forwarded-For` entry on trust, so any client could dictate the IP that
  // ends up in the audit log and in the rate limiter's key.
  app.set('trust proxy', config.http.trustProxyHops);
  // `X-Powered-By: Express` volunteers the stack to a scanner for no benefit.
  app.set('x-powered-by', false);
  // Every response is per-tenant and uncacheable (see `createSecurityHeaders`),
  // so an `ETag` is a validator for something no cache may keep.
  app.set('etag', false);

  app.setGlobalPrefix(GLOBAL_PREFIX);

  app.use(createVaryOriginHandler());
  app.enableCors(createCorsOptions(config.http.corsOrigins));
  app.use(createSecurityHeaders(config.swagger.enabled ? config.swagger.path : null));
  app.use(compression());

  // Attendance payloads are a few hundred bytes; the limit exists so a single
  // request cannot pin a worker parsing megabytes of JSON.
  app.useBodyParser('json', { limit: config.http.bodyLimit });
  app.useBodyParser('urlencoded', { limit: config.http.bodyLimit, extended: true });

  const server = app.getHttpServer();
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  // Drains in-flight requests and runs OnModuleDestroy (closing the Prisma pool)
  // on SIGTERM, which is what a rolling deploy sends.
  app.enableShutdownHooks();

  const swaggerMounted = setupSwagger(app, config);

  await app.init();

  // Registered after init so they sit last in the Express stack — the only
  // position from which a fallback sees what the router did not handle.
  // `resolve`, not `get`: nestjs-pino registers PinoLogger as transient-scoped.
  const logger = await app.resolve(PinoLogger);

  logger.setContext('Configuration');
  for (const warning of config.all.warnings) {
    logger.warn({ warning }, 'Questionable configuration');
  }

  logger.setContext('HttpFallback');
  const express = app.getHttpAdapter().getInstance();
  express.use(createNotFoundHandler());
  express.use(
    createFinalErrorHandler((error, requestId) => {
      logger.error({ err: error, requestId }, 'Request failed outside the router');
    }),
  );

  return { swaggerPath: swaggerMounted ? config.swagger.path : null };
}
