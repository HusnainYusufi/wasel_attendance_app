import type { INestApplication, ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { LOG_DESTINATION } from '../../src/common/logging/log-destination.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createMemoryLogStream, type MemoryLogStream } from './memory-log-stream.js';
import { truncateAll } from './truncate.js';

export interface CreateTestAppOptions {
  /**
   * Environment overrides applied only while the module is being built, then
   * restored. Configuration is resolved once at boot, so this is the seam for
   * exercising a different CORS allowlist, rate limit or log level.
   */
  env?: Record<string, string | undefined>;
  /** Provider overrides — e.g. replacing PrismaService to simulate a dead database. */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** Extra modules to mount alongside `AppModule`, such as a probe controller. */
  imports?: NonNullable<ModuleMetadata['imports']>;
}

export interface TestApp {
  app: INestApplication;
  /** Supertest agent bound to the real HTTP server, prefix and middleware included. */
  http: TestAgent;
  prisma: PrismaService;
  /** Everything the logger wrote during the test. */
  logs: MemoryLogStream;
  truncate: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * One log stream for the whole worker, deliberately not one per application.
 *
 * nestjs-pino v5 builds a single `pino-http` instance per *process* and memoises
 * it (`rootLogger.ts`), so the second `createTestApp()` in a file quietly reuses
 * the first application's logger and its `LOG_DESTINATION` override is never
 * consulted. With a stream per application every log assertion after the first
 * `createTestApp()` in a file runs against an empty buffer — and
 * `expect(raw).not.toContain(secret)` is trivially true of an empty buffer, so
 * the test passes while proving nothing.
 *
 * Sharing one stream keeps every assertion pointed at the bytes that were really
 * written. Vitest gives each spec file its own worker, so files cannot
 * contaminate one another; within a file, clear it in `beforeEach`.
 *
 * The same memoisation means logger *options* — `LOG_LEVEL` above all — only take
 * effect for the first application a file builds. Put a test that needs a
 * particular log level in its own file, or make it the first application there.
 */
const sharedLogs = createMemoryLogStream();

/**
 * Runs `work` with `overrides` applied to `process.env`, then restores it.
 *
 * Async on purpose: configuration is read inside module factories that Nest
 * resolves asynchronously, so a synchronous helper would restore the environment
 * the instant it received the promise — long before anything read it.
 */
async function withEnv<T>(
  overrides: Record<string, string | undefined> | undefined,
  work: () => T | Promise<T>,
): Promise<T> {
  if (!overrides) return await work();

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Boots the real application against the real test database.
 *
 * `configureApp` is shared with `main.ts`, so the suite exercises the shipped
 * pipeline — global prefix, security headers, CORS policy, body limit, throttler
 * and exception filter — rather than a hand-assembled approximation that would
 * agree with production only by luck.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const logs = sharedLogs;

  const app = await withEnv(options.env, async () => {
    const base = Test.createTestingModule({
      imports: [AppModule, ...(options.imports ?? [])],
    })
      .overrideProvider(LOG_DESTINATION)
      .useValue(logs);

    const builder = options.configure ? options.configure(base) : base;
    const moduleRef = await builder.compile();

    const created = moduleRef.createNestApplication<NestExpressApplication>({
      bufferLogs: true,
      // Matches `main.ts`: the suite must exercise the same shutdown behaviour.
      forceCloseConnections: true,
    });
    await configureApp(created);
    return created;
  });

  const prisma = app.get(PrismaService);

  return {
    app,
    http: request(app.getHttpServer()),
    prisma,
    logs,
    truncate: () => truncateAll(prisma),
    close: async () => {
      // Closes the HTTP server and runs OnModuleDestroy, which disconnects
      // Prisma. Skipping it leaks a connection pool per test file.
      await app.close();
    },
  };
}
