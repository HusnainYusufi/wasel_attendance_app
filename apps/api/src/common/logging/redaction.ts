/**
 * Fields that must never reach the log, in any shape.
 *
 * Names are matched *normalised* — lower-cased with `-` and `_` removed — so
 * `Authorization`, `access_token` and `Refresh-Token` all resolve to the same
 * entry. Adding a secret here is always cheaper than discovering it in a log
 * aggregator later.
 */
const SECRET_FIELDS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'token',
  'tokenHash',
  'secret',
  'authorization',
  'cookie',
  'setCookie',
  'apiKey',
  'x-api-key',
] as const;

export const REDACTION_PLACEHOLDER = '[REDACTED]';

/** Deepest level the censoring walker descends before giving up. */
const MAX_WALK_DEPTH = 12;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

const SECRET_KEYS: ReadonlySet<string> = new Set(SECRET_FIELDS.map(normalizeKey));

/** True when a property name denotes a secret, whatever its casing or separators. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(normalizeKey(key));
}

/**
 * Only plain objects and arrays are descended into.
 *
 * A class instance reached from a log record is almost always a host object —
 * `ServerResponse`, `Error`, a Prisma client, a socket — whose graph is enormous
 * and self-referential. Walking one would cost more than the whole log line and
 * could not terminate without a visited set large enough to matter. Their own
 * enumerable fields are still censored when such an object is passed as the
 * *root* (see {@link censorSecrets}), which is how pino's `err` serializer output
 * arrives.
 */
function isWalkable(value: unknown): value is Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copy that keeps the prototype and every own descriptor, including the
 * non-enumerable ones.
 *
 * A plain spread would be cheaper, but the objects that reach here are not always
 * plain: pino's error serialiser returns a record built on its own prototype, and
 * an unwrapped `Error` keeps `message` and `stack` as non-enumerable own
 * properties. Spreading either would silently delete the very fields the log line
 * exists for. Only ever runs when a secret was actually found.
 */
function shallowCopy<T extends object>(input: T): T {
  return Object.create(Object.getPrototypeOf(input), Object.getOwnPropertyDescriptors(input)) as T;
}

/**
 * Pass one: does this record hold a secret anywhere?
 *
 * Allocation-free and cycle-safe. The overwhelming majority of log lines answer
 * `false` here and are handed straight back to pino by identity.
 */
function containsSecret(value: unknown, depth: number, seen: Set<object>): boolean {
  if (depth > MAX_WALK_DEPTH || !isWalkable(value) || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.some((item) => containsSecret(item, depth + 1, seen));
    }
    return recordContainsSecret(value, depth, seen);
  } finally {
    seen.delete(value);
  }
}

function recordContainsSecret(
  record: Record<string, unknown>,
  depth: number,
  seen: Set<object>,
): boolean {
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined) continue;
    if (isSecretKey(key)) return true;
    if (containsSecret(value, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * Pass two: rebuild the record with every secret replaced.
 *
 * `copies` maps each original container to its replacement, so a cycle resolves
 * to the *censored* copy rather than back to the original — which is what a
 * copy-on-write walker gets wrong: it hands pino a redacted node whose `self`
 * still points at the untouched one, and pino happily prints it.
 */
function copyCensored(value: unknown, depth: number, copies: Map<object, unknown>): unknown {
  if (depth > MAX_WALK_DEPTH || !isWalkable(value)) return value;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const item of value) copy.push(copyCensored(item, depth + 1, copies));
    return copy;
  }

  return copyRecordCensored(value, depth, copies);
}

function copyRecordCensored(
  record: Record<string, unknown>,
  depth: number,
  copies: Map<object, unknown>,
): Record<string, unknown> {
  const copy = shallowCopy(record);
  copies.set(record, copy);
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined) continue;
    copy[key] = isSecretKey(key) ? REDACTION_PLACEHOLDER : copyCensored(value, depth + 1, copies);
  }
  return copy;
}

/**
 * Replaces every secret-named property with the placeholder, at any depth.
 *
 * Why a walker rather than a longer list of fast-redact paths: pino's `redact`
 * matches *concrete* paths, and `*` matches exactly one level. Covering nesting
 * therefore means enumerating `*.f`, `*.*.f`, `*.*.*.f`… for every field and every
 * capitalisation, which is unbounded in both directions and silently stops
 * working one level deeper than whoever wrote the list imagined. Arrays are the
 * case that matters most here: `{ users: [{ password }] }` is already depth two,
 * and any list of rows an export path logs is deeper still.
 *
 * The cost is one allocation-free walk of the log record per line. That is
 * strictly cheaper than the `JSON.stringify` pino runs over the same record
 * immediately afterwards, and a record with nothing to hide is returned by
 * identity — the caller's object is never mutated.
 *
 * The root is inspected whatever its prototype: pino's `err` serialiser returns
 * an object built on its own prototype, and that is exactly where a context
 * object attached to a thrown error ends up.
 */
export function censorSecrets<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    return (containsSecret(value, 0, new Set()) ? copyCensored(value, 0, new Map()) : value) as T;
  }

  const record = value as unknown as Record<string, unknown>;
  if (!recordContainsSecret(record, 0, new Set())) return value;
  return copyRecordCensored(record, 0, new Map()) as unknown as T;
}

/**
 * fast-redact paths for the values a log record only acquires *after*
 * {@link censorSecrets} has run.
 *
 * `req` is attached by pino-http as a child binding, and `res`/`err` are replaced
 * by their serialisers — all three happen downstream of `formatters.log`, so the
 * walker never sees them. The request serialiser is an allowlist and the response
 * serialiser keeps only the status code, so these paths are a second line rather
 * than the first: they are what still holds if somebody widens either allowlist.
 */
export function buildRedactionPaths(): string[] {
  return [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'res.headers["set-cookie"]',
  ];
}

export const REDACTED_FIELDS: readonly string[] = SECRET_FIELDS;
