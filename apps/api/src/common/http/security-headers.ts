import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Every API response is uncacheable.
 *
 * Responses are per-tenant and per-user, and Express volunteers a strong `ETag`
 * for each of them. A shared cache that treats one as reusable hands one
 * organisation's attendance data to another. Documentation is static and public,
 * so it keeps whatever caching the docs middleware chooses.
 */
const NO_STORE = 'no-store';

/**
 * Helmet with a JSON-API-appropriate policy, plus a relaxed variant for the
 * Swagger UI route.
 *
 * Swagger UI bootstraps itself with inline `<script>`/`<style>`, which a strict
 * `default-src 'self'` blocks — the page renders blank. Rather than weakening the
 * policy for the whole service, the relaxation is scoped to the docs path, which
 * is disabled in production anyway.
 *
 * `docsPath` must not be a prefix of the API path: `/api` would make every
 * `/api/v1/...` route "documentation" and serve the entire API under the relaxed
 * policy. `envSchema` refuses to boot such a value rather than relying on this
 * function to notice.
 */
export function createSecurityHeaders(docsPath: string | null): RequestHandler {
  const strict = helmet({
    contentSecurityPolicy: {
      // `useDefaults: false` matters: helmet's defaults include
      // `style-src 'self' https: 'unsafe-inline'`, which would silently reintroduce
      // inline styles into a policy that is meant to permit nothing at all. A JSON
      // API loads no subresources, so the correct policy is exactly this short.
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // The API is served over TLS by the ingress; HSTS is emitted so a browser
    // never retries over plaintext after a single successful HTTPS response.
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  const strictWithNoStore: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', NO_STORE);
    strict(req, res, next);
  };

  if (!docsPath) return strictWithNoStore;

  const relaxedForDocs = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  const prefix = docsPath.endsWith('/') ? docsPath.slice(0, -1) : docsPath;

  return (req, res, next) => {
    const path = req.originalUrl.split('?')[0] ?? '';
    const isDocs = path === prefix || path.startsWith(`${prefix}/`);
    return isDocs ? relaxedForDocs(req, res, next) : strictWithNoStore(req, res, next);
  };
}
