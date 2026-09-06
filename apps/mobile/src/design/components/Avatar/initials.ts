/** Trailing initials of the first and last word: "Aisha binti Rahman" → "AR". */
export function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  const letters = `${first.charAt(0)}${last.charAt(0)}` || first.charAt(0);
  return letters.toUpperCase();
}

/** djb2 — stable across reloads and platforms, which `Math.random` is not. */
export function tintIndex(name: string, buckets: number): number {
  let hash = 5381;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % buckets;
}
