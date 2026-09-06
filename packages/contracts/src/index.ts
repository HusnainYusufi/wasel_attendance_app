/**
 * @wasel/contracts — the single source of truth for the API surface.
 *
 * The NestJS API validates every inbound request with these schemas and derives
 * its OpenAPI document from them; the React client infers its types from the very
 * same definitions. A breaking change therefore fails the build on both sides at
 * once instead of surfacing as a runtime 400 in production.
 */
export * from './constants.js';
export * from './errors.js';
export * from './common.js';
export * from './geo.js';
export * from './auth.js';
export * from './attendance.js';
export * from './attendance-entry.js';
export * from './admin.js';
export * from './profile.js';
export * from './reminders.js';
