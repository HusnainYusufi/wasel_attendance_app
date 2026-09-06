import { applyTestEnv } from './test-env.js';

// Unit tests perform no I/O, but a few of them construct application config from
// the ambient environment; giving them the same baseline as the integration suite
// keeps a failure from depending on whether the developer has a `.env`.
try {
  applyTestEnv();
} catch {
  // No TEST_DATABASE_URL on this machine. Unit tests do not need one, and the
  // integration suite reports the same condition with a far clearer message.
  process.env['NODE_ENV'] = 'test';
}
