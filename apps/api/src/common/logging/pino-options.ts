import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { AppConfigService } from '../../config/app-config.service.js';
import {
  buildRedactionPaths,
  censorSecrets,
  isSecretKey,
  REDACTION_PLACEHOLDER,
} from './redaction.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

/** Probes fire every few seconds; logging them buries everything else. */
const UNLOGGED_PATHS = new Set(['/api/v1/health/live', '/api/v1/health/ready']);

/**
 * Headers worth keeping on a request record.
 *
 * An allowlist rather than "everything minus the redaction list": a header added
 * later — by a proxy, an SDK, a future feature — is then absent from the log by
 * default instead of leaking until somebody notices and extends a denylist.
 */
const LOGGED_REQUEST_HEADERS = [
  'host',
  'user-agent',
  'referer',
  'content-type',
  'content-length',
  'accept',
  'origin',
  REQUEST_ID_HEADER,
] as const;

/** Headers whose value is itself a URL and therefore carries a query string. */
const URL_VALUED_HEADERS = new Set<string>(['referer']);

/**
 * Query parameters censored in any logged URL.
 *
 * Redaction matches property names, and a query string has none — `?token=…` is
 * one opaque character sequence to pino. Password-reset links, OAuth callbacks
 * and "click here to confirm" URLs all put the credential in the query, and the
 * `Referer` header carries whichever one the user last visited.
 */
const SENSITIVE_QUERY_PARAMS = new Set(['code', 'key']);

function isSensitiveQueryParam(name: string): boolean {
  return isSecretKey(name) || SENSITIVE_QUERY_PARAMS.has(name.toLowerCase());
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Replaces the value of every sensitive query parameter, leaving the rest of the
 * URL byte-for-byte intact so it stays greppable and joinable.
 */
export function censorUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const hashStart = url.indexOf('#', queryStart);
  const path = url.slice(0, queryStart);
  const query = hashStart === -1 ? url.slice(queryStart + 1) : url.slice(queryStart + 1, hashStart);
  const hash = hashStart === -1 ? '' : url.slice(hashStart);

  let censored = false;
  const pairs = query.split('&').map((pair) => {
    const equals = pair.indexOf('=');
    const name = equals === -1 ? pair : pair.slice(0, equals);
    if (!isSensitiveQueryParam(safeDecode(name))) return pair;
    censored = true;
    return `${name}=${REDACTION_PLACEHOLDER}`;
  });

  return censored ? `${path}?${pairs.join('&')}${hash}` : url;
}

function censorHeaderValue(name: string, value: string | string[]): string | string[] {
  if (!URL_VALUED_HEADERS.has(name)) return value;
  return Array.isArray(value) ? value.map(censorUrl) : censorUrl(value);
}

/**
 * The shape a custom `req` serialiser actually receives.
 *
 * pino-http wraps it with `pino-std-serializers`' `wrapRequestSerializer`, so by
 * the time this function runs the raw `IncomingMessage` has already been reduced
 * to a flat record: there is no `socket`, and the peer address arrives as
 * `remoteAddress`. Reaching for `req.socket.remoteAddress` here compiles, passes
 * a hand-fed unit test, and logs `undefined` in production.
 */
interface WrappedRequest {
  id?: unknown;
  method?: string;
  url?: string;
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface SerializedRequest {
  id: unknown;
  method: string | undefined;
  url: string | undefined;
  remoteAddress: string | undefined;
  headers: Record<string, string | string[]>;
}

/**
 * Deliberately omits the request body. Bodies routinely carry credentials, and
 * "log the body but redact the secret fields" only works for the field names
 * somebody remembered to list.
 */
export function serializeRequest(req: WrappedRequest): SerializedRequest {
  const headers: Record<string, string | string[]> = {};
  for (const name of LOGGED_REQUEST_HEADERS) {
    const value = req.headers?.[name];
    if (value !== undefined) headers[name] = censorHeaderValue(name, value);
  }

  return {
    id: req.id,
    method: req.method,
    url: typeof req.url === 'string' ? censorUrl(req.url) : req.url,
    // `remoteAddress`, not `socket.remoteAddress` — see {@link WrappedRequest}.
    remoteAddress: req.remoteAddress,
    headers,
  };
}

interface WrappedResponse {
  statusCode?: number | null;
}

/**
 * The status code and nothing else.
 *
 * The default serialiser emits every response header on every request: a
 * `set-cookie` waiting to be leaked by the next feature that sets one, and
 * otherwise pure volume — the headers are the same on every line and no query
 * has ever needed them.
 */
export function serializeResponse(res: WrappedResponse): { statusCode: number | null | undefined } {
  return { statusCode: res.statusCode };
}

export function buildPinoHttpOptions(config: AppConfigService): PinoHttpOptions {
  return {
    level: config.log.level,

    // Accept a caller-supplied id so a trace survives the proxy hop, and echo it
    // back on the response so a user reporting a failure can quote the exact id
    // that appears in the server log.
    genReqId: (req: IncomingMessage, res: ServerResponse): string => {
      const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },

    // Runs before the serialisers and before `redact`, on the object the caller
    // passed to `logger.info(...)` — which is where a module's context object,
    // and therefore a nested or listed secret, arrives.
    formatters: {
      log: (object: Record<string, unknown>): Record<string, unknown> => censorSecrets(object),
    },

    redact: { paths: buildRedactionPaths(), censor: REDACTION_PLACEHOLDER },

    serializers: {
      req: serializeRequest,
      res: serializeResponse,
      // pino-http wraps this with the standard error serialiser, so the argument
      // is the flattened `{ type, message, stack, …attached properties }` record.
      // Those attached properties are ordinary application objects and are the
      // one place a secret can still be hiding by the time we see them.
      err: (error: unknown): unknown => censorSecrets(error),
    },

    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },

    autoLogging: {
      ignore: (req: IncomingMessage) => UNLOGGED_PATHS.has((req.url ?? '').split('?')[0] ?? ''),
    },

    ...(config.log.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
              singleLine: false,
            },
          },
        }
      : {}),
  };
}
