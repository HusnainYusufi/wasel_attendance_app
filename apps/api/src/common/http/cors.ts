import type { RequestHandler } from 'express';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';
import { REQUEST_ID_HEADER } from '../logging/request-id.js';

/**
 * Marks every response as varying by `Origin`, whatever the CORS decision was.
 *
 * The CORS layer only adds `Vary: Origin` to the responses it *allows*. A shared
 * cache in front of the API therefore cannot tell an allowed response from a
 * denied one and will happily serve one origin's cached response — headers
 * included — to another. Emitting it unconditionally, before the CORS middleware
 * runs, makes the cache key honest for allowed, denied and non-CORS requests
 * alike.
 */
export function createVaryOriginHandler(): RequestHandler {
  return (_req, res, next) => {
    res.vary('Origin');
    next();
  };
}

/**
 * CORS restricted to an explicit allowlist.
 *
 * The origin callback answers `false` — rather than echoing the caller's
 * `Origin` — for anything not on the list. With `credentials: true` an echoed
 * origin is equivalent to `Access-Control-Allow-Origin: *` with cookies, i.e.
 * any site could read authenticated responses on a user's behalf.
 *
 * A request with no `Origin` header (curl, a mobile WebView, a server-to-server
 * call) is not a CORS request at all: no header is emitted and the request
 * proceeds, because the browser same-origin policy is what CORS relaxes, and
 * there is nothing to relax when no browser is involved.
 */
export function createCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  const allowlist = new Set(allowedOrigins);

  return {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, false);
        return;
      }
      callback(null, allowlist.has(origin));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER],
    maxAge: 600,
    optionsSuccessStatus: 204,
  };
}
