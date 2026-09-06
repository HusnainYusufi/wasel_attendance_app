import type { ZodIssue } from 'zod';
import type { ErrorDetail } from '../errors/app.exception.js';

/**
 * Dot-joined JSON path for an issue, e.g. `user.email` or `items.0.id`.
 *
 * Array indices join with a dot rather than `[0]` so a client can split on `.`
 * to walk the payload. A root-level issue (a cross-field `.refine` with no
 * `path`) yields an empty string, which clients render as a form-level error.
 */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((segment) => String(segment)).join('.');
}

/**
 * `root` names the argument being validated, when the decorator addressed one by
 * name — `@ZodParam('id', uuidSchema)`. Without it every failure on a scalar
 * argument reports `path: ''`, which a client cannot attach to an input: three
 * different named parameters would all describe themselves as "the form".
 */
export function formatZodIssues(issues: readonly ZodIssue[], root?: string): ErrorDetail[] {
  return issues.map((issue) => {
    const path = formatIssuePath(issue.path ?? []);
    return {
      path: root ? (path ? `${root}.${path}` : root) : path,
      message: issue.message,
    };
  });
}
