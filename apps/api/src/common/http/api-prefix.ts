/**
 * The version prefix every API route is mounted under.
 *
 * Lives here rather than in `bootstrap.ts` because the environment schema has to
 * validate other paths against it — `SWAGGER_PATH` in particular — and importing
 * the bootstrap module from the configuration layer would close a cycle.
 */
export const API_GLOBAL_PREFIX = 'api/v1';

/** The same prefix as an absolute path: `/api/v1`. */
export const API_PATH_PREFIX = `/${API_GLOBAL_PREFIX}`;
