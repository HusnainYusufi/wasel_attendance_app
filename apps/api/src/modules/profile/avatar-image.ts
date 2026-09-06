import { AVATAR_MIME_TYPES, type AvatarMimeType } from '@wasel/contracts';

/**
 * Image identification from the bytes themselves.
 *
 * `Content-Type` is a claim made by the caller, and this module exists because
 * that claim is worthless as a security control: anyone can `PUT` a payload
 * labelled `image/jpeg`. What is stored — and later served back with a
 * `Content-Type` of our own choosing — must be what the bytes actually are, or
 * the avatar endpoint becomes a way to host arbitrary content on the API's
 * origin under a type the browser will honour.
 *
 * Everything here is pure and takes a `Uint8Array`, so the whole decision is
 * unit-testable without an HTTP server, a database or a temporary file.
 */

/**
 * Formats this module can *name*, which is deliberately wider than the set the
 * product accepts.
 *
 * Recognising HEIC and AVIF buys nothing security-wise — they are rejected
 * either way — but it turns "that image could not be read" into "your phone
 * saved this as HEIC and it could not be converted", which is the difference
 * between a user retrying and a user giving up.
 */
export const ImageFormat = {
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  WEBP: 'image/webp',
  GIF: 'image/gif',
  BMP: 'image/bmp',
  TIFF: 'image/tiff',
  AVIF: 'image/avif',
  HEIC: 'image/heic',
  SVG: 'image/svg+xml',
} as const;
export type ImageFormat = (typeof ImageFormat)[keyof typeof ImageFormat];

/** Human-facing names, for an error message that tells the user what they picked. */
const FORMAT_LABELS: Readonly<Record<ImageFormat, string>> = {
  [ImageFormat.JPEG]: 'JPEG',
  [ImageFormat.PNG]: 'PNG',
  [ImageFormat.WEBP]: 'WebP',
  [ImageFormat.GIF]: 'GIF',
  [ImageFormat.BMP]: 'BMP',
  [ImageFormat.TIFF]: 'TIFF',
  [ImageFormat.AVIF]: 'AVIF',
  [ImageFormat.HEIC]: 'HEIC',
  [ImageFormat.SVG]: 'SVG',
};

export function imageFormatLabel(format: ImageFormat | null): string {
  return format === null ? 'an unrecognised format' : FORMAT_LABELS[format];
}

/** How much of a text-ish payload is examined when looking for an SVG root element. */
const SVG_PROBE_BYTES = 1024;

const ACCEPTED: ReadonlySet<string> = new Set<string>(AVATAR_MIME_TYPES);

/** Narrows a stored or parsed string to the accepted set. */
export function isAvatarMimeType(value: string): value is AvatarMimeType {
  return ACCEPTED.has(value);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** ASCII comparison over a byte window — used for the four-character box types. */
function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * ISO base-media brands, read from the `ftyp` box at offset 8.
 *
 * HEIC and AVIF share the container that MP4 uses, so the discriminator is the
 * brand rather than a fixed magic number. `mif1`/`msf1` are the generic HEIF
 * brands an iPhone also emits.
 */
const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'];
const AVIF_BRANDS = ['avif', 'avis'];

/**
 * Does this payload begin with an XML/SVG document?
 *
 * Byte-level signatures cannot answer this — SVG is text — so the first kilobyte
 * is decoded and inspected for a root `<svg>` element, allowing for a UTF-8 BOM,
 * leading whitespace, an XML declaration, a doctype or a comment ahead of it.
 * Being *approximate here is safe*: this detection only ever produces a
 * rejection, and an SVG that somehow slipped past it would still be refused by
 * the accepted-type check, which is an allowlist.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const bom = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  const head = Buffer.from(bytes.subarray(bom, bom + SVG_PROBE_BYTES))
    .toString('utf8')
    .trimStart();
  if (!head.startsWith('<')) return false;
  return /<svg[\s/>]/i.test(head);
}

/**
 * The format the bytes really are, or `null` when nothing matches.
 *
 * Ordering matters only in that the container formats are checked by their own
 * offsets; the signatures themselves are mutually exclusive.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  // FF D8 FF — SOI followed by the first marker. Two bytes would also match the
  // start of a few unrelated formats, so all three are required.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return ImageFormat.JPEG;
  if (startsWith(bytes, PNG_SIGNATURE)) return ImageFormat.PNG;

  // RIFF container: "RIFF" <u32 size> "WEBP".
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return ImageFormat.WEBP;

  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return ImageFormat.GIF;
  if (asciiAt(bytes, 0, 'BM')) return ImageFormat.BMP;
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])) return ImageFormat.TIFF;
  if (startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return ImageFormat.TIFF;

  if (asciiAt(bytes, 4, 'ftyp')) {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString('latin1');
    if (AVIF_BRANDS.includes(brand)) return ImageFormat.AVIF;
    if (HEIC_BRANDS.includes(brand)) return ImageFormat.HEIC;
  }

  if (looksLikeSvg(bytes)) return ImageFormat.SVG;

  return null;
}

/**
 * The media type from a `Content-Type` header, lowercased and stripped of
 * parameters, or `null` when the header is absent or unusable.
 *
 * `image/jpeg; charset=binary` and `IMAGE/JPEG` are the same type; treating them
 * as different would reject perfectly ordinary clients.
 */
export function parseImageContentType(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const essence = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return essence.length > 0 ? essence : null;
}

/**
 * A declared `Content-Length`, or `null` when it is absent or not a number.
 *
 * Only ever used to refuse an oversized upload *before* reading it. A caller
 * that lies low — or omits the header entirely, as a chunked request does — is
 * caught by the streaming cap instead, so nothing here is trusted.
 */
export function parseContentLength(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}
