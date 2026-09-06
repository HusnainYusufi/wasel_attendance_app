import { Global, Module } from '@nestjs/common';
import type { DestinationStream } from 'pino';

/**
 * Optional override for where pino writes.
 *
 * Production never sets it (pino writes to stdout). Tests bind a memory stream so
 * that assertions about redaction inspect the bytes that would really be written,
 * rather than trusting a mock of the logger.
 */
export const LOG_DESTINATION = 'WASEL_LOG_DESTINATION';

export type LogDestination = DestinationStream | null;

@Global()
@Module({
  providers: [{ provide: LOG_DESTINATION, useValue: null satisfies LogDestination }],
  exports: [LOG_DESTINATION],
})
export class LogDestinationModule {}
