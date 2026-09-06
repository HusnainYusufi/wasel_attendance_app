import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { paginationQuerySchema, uuidSchema } from '@wasel/contracts';
import { z } from 'zod';
import { Public } from '../../src/common/auth/public.decorator.js';
import { Errors } from '../../src/common/errors/app.exception.js';
import { ZodBody, ZodParam, ZodQuery } from '../../src/common/pipes/zod-param.decorators.js';

/**
 * A secret planted in a server-side failure. Every assertion that the client
 * never sees server internals greps the response for exactly this string.
 */
export const LEAKED_SECRET = 'db_password=hunter2-should-never-ship';

export const probeBodySchema = z.object({
  user: z.object({ email: z.string().email(), age: z.number().int().min(18) }),
  items: z.array(z.object({ id: uuidSchema })).min(1),
});

interface FakePrismaError extends Error {
  code: string;
  meta: { target: string[] };
  clientVersion: string;
}

function fakeUniqueViolation(): FakePrismaError {
  // Shaped like a real `PrismaClientKnownRequestError` without needing a database
  // round-trip; `prisma-errors.ts` matches structurally, exactly so this works.
  const error = new Error(
    'Unique constraint failed on the fields: (`organizationId`,`email`)',
  ) as FakePrismaError;
  error.name = 'PrismaClientKnownRequestError';
  error.code = 'P2002';
  error.meta = { target: ['organizationId', 'email'] };
  error.clientVersion = '7.10.0';
  return error;
}

/**
 * Routes that exist only to exercise the kernel: the exception filter, the
 * validation pipe, the throttler and the logger redaction. They are never
 * compiled into `dist`, because they live under `test/`.
 */
@Public()
@Controller('__probe')
export class ProbeController {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ProbeController.name);
  }

  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get('unhandled')
  unhandled(): never {
    throw new Error(`internal failure: ${LEAKED_SECRET}`);
  }

  @Get('app-error')
  appError(): never {
    throw Errors.notFound('Site');
  }

  @Get('conflict')
  conflict(): never {
    throw fakeUniqueViolation();
  }

  @Get('prisma-missing')
  prismaMissing(): never {
    const error = new Error('An operation failed because it depends on one or more records');
    error.name = 'PrismaClientKnownRequestError';
    Object.assign(error, { code: 'P2025', clientVersion: '7.10.0' });
    throw error;
  }

  @Post('validate')
  validate(@ZodBody(probeBodySchema) body: z.output<typeof probeBodySchema>): unknown {
    return body;
  }

  @Get('paginate')
  paginate(
    @ZodQuery(paginationQuerySchema) query: z.output<typeof paginationQuerySchema>,
  ): unknown {
    return query;
  }

  @Get('entity/:id')
  entity(@ZodParam('id', uuidSchema) id: string): { id: string } {
    return { id };
  }

  /**
   * Logs the request body verbatim, exactly as a module author debugging a login
   * failure would.
   *
   * The body must actually reach the logger for "the password never reaches the
   * log" to mean anything: the request serialiser omits bodies, so a test that
   * only issues the request passes with redaction deleted entirely.
   */
  @Post('credentials')
  credentials(@Body() body: unknown): { received: true } {
    this.logger.info({ body }, 'probe received credentials');
    return { received: true };
  }

  /** The same, one level deeper and inside a list of rows. */
  @Post('credentials-nested')
  credentialsNested(@Body() body: unknown): { received: true } {
    this.logger.info(
      { context: { request: body }, rows: [{ index: 0, payload: body }] },
      'probe received nested credentials',
    );
    return { received: true };
  }

  /** Logs whatever headers arrived, the way a request-tracing helper would. */
  @Post('echo-headers')
  echoHeaders(@Body() body: { headers?: unknown }): { received: true } {
    this.logger.info({ headers: body.headers }, 'probe received headers');
    return { received: true };
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
