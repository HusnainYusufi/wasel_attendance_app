/**
 * Public surface of the reminders module.
 *
 * The pure scheduling rule is exported alongside the module because it is the
 * part worth reusing and the part worth testing; the service and controller are
 * exported for the application root to wire.
 */
export {
  MIN_REMINDER_SPACING_MS,
  MIN_REMINDER_WINDOW_MS,
  expectedCheckOutInstant,
  planShiftReminders,
  type ShiftReminderInput,
} from './reminder-plan.js';
export { RemindersController } from './reminders.controller.js';
export { RemindersModule } from './reminders.module.js';
export { RemindersService } from './reminders.service.js';
