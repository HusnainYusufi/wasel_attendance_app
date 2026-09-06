import { Module } from '@nestjs/common';
import { RemindersController } from './reminders.controller.js';
import { RemindersService } from './reminders.service.js';

/**
 * Check-out reminders.
 *
 * Imports nothing: `PrismaModule`, `ClockModule` and `AuthModule` are all
 * `@Global()`, and everything else this module needs is a pure function.
 *
 * It reads the attendance module's `work-date` helpers and its carry-over
 * constant but not its services — the plan is derived from one row and the
 * tenant's policy, so there is nothing to inject and nothing to keep in sync.
 * Nothing here writes: a reminder schedule is a *view* of an open shift, which
 * is why check-out needs no reminder-specific teardown on the server.
 */
@Module({
  controllers: [RemindersController],
  providers: [RemindersService],
})
export class RemindersModule {}
