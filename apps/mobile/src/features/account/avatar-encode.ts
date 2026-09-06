import {
  AVATAR_ENCODE_MIME_TYPE,
  AVATAR_ENCODE_QUALITY,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_EDGE_PX,
} from '@wasel/contracts';

/**
 * "Any format" — resolved on the client, where the decoders already are.
 *
 * The customer asked for any format. The server accepts three, and deliberately:
 * accepting HEIC or AVIF there would mean shipping a native image library into
 * the API container, keeping it patched (image decoders are a perennial source
 * of memory-safety CVEs), and burning server CPU on every upload. Meanwhile the
 * device that took the photo can already decode it — that is how it displayed it
 * in the picker — so the conversion happens here.
 *
 * The browser decodes whatever it can open (HEIC from an iPhone, AVIF, PNG,
 * WebP, GIF, BMP) and this re-encodes it to JPEG, scaled so the longest edge is
 * at most {@link AVATAR_MAX_EDGE_PX}. The upload is then tens of kilobytes of a
 * format every browser renders, and the stored rows stay small.
 *
 * None of this is a security control. The server independently sniffs the magic
 * bytes of whatever arrives and refuses anything that does not match its own
 * allowlist — this module is a convenience for honest clients, and is treated as
 * exactly that on the other end.
 */

/** The picked file could not be decoded by this browser. */
export class UnreadableImageError extends Error {
  constructor() {
    super('That image could not be read on this device');
    this.name = 'UnreadableImageError';
  }
}

/** The image could not be squeezed under the size cap. Practically unreachable. */
export class ImageTooLargeError extends Error {
  constructor() {
    super('That image is too large to upload');
    this.name = 'ImageTooLargeError';
  }
}

export interface EncodedAvatar {
  blob: Blob;
  /** Always one of the server's accepted types — see {@link AVATAR_ENCODE_MIME_TYPE}. */
  contentType: string;
  width: number;
  height: number;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decodes with `createImageBitmap`, falling back to an `<img>` element.
 *
 * `imageOrientation: 'from-image'` is not optional. A phone camera stores the
 * frame in the sensor's orientation and records the rotation in EXIF; ignoring
 * it means every portrait selfie is uploaded on its side, permanently, because
 * the re-encode bakes the wrong rotation into pixels and discards the metadata
 * that would have corrected it.
 *
 * The `<img>` fallback exists for browsers whose `createImageBitmap` refuses a
 * format their `<img>` decoder accepts — which was true of WebKit for several
 * formats — so trying both is the difference between "your photo works" and
 * "your photo works on Chrome".
 */
async function decode(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through to the element decoder.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new UnreadableImageError());
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new UnreadableImageError())),
      type,
      quality,
    );
  });
}

/**
 * Quality ladder for the re-encode.
 *
 * The first rung is the intended quality and is what essentially every photo
 * lands on. The rest exist so that a pathological input — a 512 px frame of pure
 * noise, which JPEG cannot compress — degrades instead of being refused: an
 * upload that fails at the last step is worse than one that is slightly softer.
 */
const QUALITY_LADDER = [AVATAR_ENCODE_QUALITY, 0.7, 0.55, 0.4];

/**
 * Decodes, downscales and re-encodes a picked file into an uploadable JPEG.
 *
 * @throws {UnreadableImageError} the browser cannot decode this file
 * @throws {ImageTooLargeError} the result stayed over the cap at every quality
 */
export async function encodeAvatar(file: Blob): Promise<EncodedAvatar> {
  const decoded = await decode(file);
  try {
    // Never upscale: enlarging a 64 px avatar to 512 px costs bytes and adds no
    // detail that was not already there.
    const scale = Math.min(1, AVATAR_MAX_EDGE_PX / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) throw new UnreadableImageError();

    // JPEG has no alpha channel, and an unpainted canvas is transparent black —
    // so a PNG or WebP with transparency would be re-encoded onto black, and a
    // logo with a transparent background would arrive as a black square.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.source, 0, 0, width, height);

    for (const quality of QUALITY_LADDER) {
      const blob = await toBlob(canvas, AVATAR_ENCODE_MIME_TYPE, quality);
      if (blob.size <= AVATAR_MAX_BYTES) {
        return { blob, contentType: AVATAR_ENCODE_MIME_TYPE, width, height };
      }
    }
    throw new ImageTooLargeError();
  } finally {
    decoded.release();
  }
}
