import type { AuthTokens, RefreshResponse } from '@wasel/contracts';
import { ErrorCode } from '@wasel/contracts';
import { endpoints } from './endpoints';
import {
  ApiError,
  isApiErrorBody,
  NetworkError,
  RequestCanceledError,
  synthesizeErrorBody,
  TimeoutError,
} from './errors';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Serialised as JSON unless it is already a `FormData`/`Blob`. */
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  /** Set false for endpoints that must not carry (or refresh) a bearer token. */
  auth?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface ApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Persist rotated tokens. Called on refresh success and on sign-out (null). */
  onSessionChange?: (tokens: AuthTokens | null) => void;
  /** The session is unrecoverable: drop caches and route to sign-in. */
  onSignOut?: (reason: 'refresh-failed' | 'no-refresh-token') => void;
}

export interface BinaryResponse {
  blob: Blob;
  filename: string | null;
  contentType: string;
}

function buildQuery(query: QueryParams | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
    } else {
      params.append(key, String(value));
    }
  }
  const serialised = params.toString();
  return serialised ? `?${serialised}` : '';
}

/** RFC 6266 `filename*` first, then the plain `filename`. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      // A malformed header must not sink the download.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? null;
}

/**
 * The HTTP layer.
 *
 * Responsibilities, in order of how much damage getting them wrong would do:
 *
 *  1. **Single-flight token refresh.** Concurrent 401s trigger exactly one
 *     `POST /auth/refresh`; every other caller awaits the same promise and then
 *     retries with the new token. Refresh tokens rotate server-side, so two
 *     parallel refreshes would burn each other's token and log the user out —
 *     usually right as they tap CHECK IN.
 *  2. **Typed failures.** HTTP errors arrive as `ApiError` carrying the
 *     contract's `code`; transport failures are their own classes.
 *  3. **Cancellation.** A caller `AbortSignal` is honoured and reported as
 *     `RequestCanceledError`, distinct from a timeout.
 */
export class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  /** Non-null exactly while a refresh is in flight. This is the single-flight latch. */
  private refreshInFlight: Promise<string> | null = null;

  constructor(private readonly options: ApiClientOptions) {}

  getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Only for `POST /auth/logout`, which revokes this specific refresh token. */
  getRefreshToken(): string | null {
    return this.refreshToken;
  }

  hasSession(): boolean {
    return this.refreshToken !== null;
  }

  /** Installs tokens without persisting — the caller owns persistence. */
  setSession(tokens: AuthTokens | null): void {
    this.accessToken = tokens?.accessToken ?? null;
    this.refreshToken = tokens?.refreshToken ?? null;
    // A session change invalidates any refresh racing against the old token.
    this.refreshInFlight = null;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);
    return this.parse<T>(response);
  }

  /** For file downloads (CSV/XLSX export) — same auth and refresh behaviour. */
  async requestBinary(path: string, options: RequestOptions = {}): Promise<BinaryResponse> {
    const response = await this.send(path, {
      ...options,
      headers: { Accept: '*/*', ...options.headers },
    });
    return {
      blob: await response.blob(),
      filename: filenameFromDisposition(response.headers.get('content-disposition')),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  // -------------------------------------------------------------------------

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const useAuth = options.auth !== false;
    const tokenUsed = useAuth ? this.accessToken : null;

    const response = await this.fetchOnce(path, options, tokenUsed);
    if (response.status !== 401 || !useAuth) {
      if (!response.ok) throw await this.toApiError(response);
      return response;
    }

    // --- 401 handling ------------------------------------------------------
    if (!this.refreshToken) {
      this.failSession('no-refresh-token');
      throw await this.toApiError(response);
    }

    let freshToken: string;
    try {
      freshToken = await this.refreshAccessToken(tokenUsed);
    } catch (error) {
      // Refresh failed for real (revoked, expired, reused). Everything else —
      // a network blip — is rethrown as-is so the caller can offer a retry
      // instead of being bounced to the sign-in screen while offline.
      if (error instanceof ApiError) {
        this.failSession('refresh-failed');
        throw error;
      }
      throw error;
    }

    const retried = await this.fetchOnce(path, options, freshToken);
    if (retried.status === 401) {
      // A token minted seconds ago was still rejected: the account was
      // suspended or the session revoked server-side. Nothing to retry.
      const error = await this.toApiError(retried);
      this.failSession('refresh-failed');
      throw error;
    }
    if (!retried.ok) throw await this.toApiError(retried);
    return retried;
  }

  /**
   * Returns a usable access token, refreshing at most once across all callers.
   *
   * `staleToken` is the token the failed request actually carried. If it no
   * longer matches the current one, another caller's refresh has already landed
   * and this request simply lost the race — it retries with the new token rather
   * than triggering a second, redundant rotation.
   */
  private async refreshAccessToken(staleToken: string | null): Promise<string> {
    if (staleToken !== null && this.accessToken !== null && this.accessToken !== staleToken) {
      return this.accessToken;
    }

    if (this.refreshInFlight) return this.refreshInFlight;

    const refreshToken = this.refreshToken;
    if (!refreshToken) throw new ApiError(synthesizeErrorBody(401, 'Session expired.'));

    const pending = (async (): Promise<string> => {
      const response = await this.fetchOnce(
        endpoints.auth.refresh,
        { method: 'POST', body: { refreshToken }, auth: false },
        null,
      );

      if (!response.ok) throw await this.toApiError(response);

      const payload = await this.parse<RefreshResponse>(response);
      const tokens = payload.tokens;
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken;
      this.options.onSessionChange?.(tokens);
      return tokens.accessToken;
    })();

    this.refreshInFlight = pending;
    try {
      return await pending;
    } finally {
      // Cleared in `finally` so a failed refresh does not wedge every later
      // request behind a permanently rejected promise.
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    }
  }

  private failSession(reason: 'refresh-failed' | 'no-refresh-token'): void {
    this.setSession(null);
    this.options.onSessionChange?.(null);
    this.options.onSignOut?.(reason);
  }

  private async fetchOnce(
    path: string,
    options: RequestOptions,
    token: string | null,
  ): Promise<Response> {
    const { method = 'GET', body, query, signal, timeoutMs, headers } = options;
    const url = `${this.options.baseUrl}${path}${buildQuery(query)}`;
    const deadline = timeoutMs ?? this.options.timeoutMs;

    const requestHeaders = new Headers({ Accept: 'application/json', ...headers });
    if (token) requestHeaders.set('Authorization', `Bearer ${token}`);

    let payload: BodyInit | undefined;
    if (body instanceof FormData || body instanceof Blob) {
      payload = body;
    } else if (body !== undefined) {
      requestHeaders.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }

    const timeoutSignal = AbortSignal.timeout(deadline);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    try {
      return await fetch(url, {
        method,
        headers: requestHeaders,
        body: payload,
        signal: combined,
        // Auth is a bearer token, never a cookie; sending credentials would only
        // widen the CORS surface for no benefit.
        credentials: 'omit',
        mode: 'cors',
      });
    } catch (error) {
      // Order matters: a caller abort and a timeout both surface as the same
      // AbortError on the combined signal, so the source signals are inspected.
      if (signal?.aborted) throw new RequestCanceledError();
      if (timeoutSignal.aborted) throw new TimeoutError(deadline);
      throw new NetworkError(error);
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      return (await response.text()) as T;
    }
    try {
      return (await response.json()) as T;
    } catch {
      // The underlying SyntaxError carries nothing a screen could act on; the
      // envelope is what callers branch on.
      throw new ApiError(
        synthesizeErrorBody(response.status, 'The server returned a malformed response.'),
      );
    }
  }

  /** Reads and parses an error body, tolerating an empty or non-JSON payload. */
  private async readErrorPayload(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  private async toApiError(response: Response): Promise<ApiError> {
    const parsed = await this.readErrorPayload(response);

    if (isApiErrorBody(parsed)) return new ApiError(parsed);

    const fallback = synthesizeErrorBody(response.status);
    // A 401 with no envelope still has to be recognisable as an expired token,
    // or the refresh path above would never engage against a bare gateway 401.
    if (response.status === 401) fallback.code = ErrorCode.TOKEN_EXPIRED;
    return new ApiError(fallback);
  }
}
