/**
 * Runtime configuration, read once and validated at module load so a missing or
 * malformed value fails immediately and visibly rather than as a confusing 404
 * on the first request.
 */

function readString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** No trailing slash, so path joining is a plain concatenation everywhere. */
const rawBaseUrl = readString(import.meta.env.VITE_API_BASE_URL, 'http://localhost:3000/api/v1');

export const env = {
  apiBaseUrl: rawBaseUrl.replace(/\/+$/, ''),
  apiTimeoutMs: readInt(import.meta.env.VITE_API_TIMEOUT_MS, 15_000),
  isDev: import.meta.env.DEV,
  isProd: import.meta.env.PROD,
} as const;
