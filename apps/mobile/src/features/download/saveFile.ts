import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * Where a downloaded file ended up, so the UI can say something true rather than
 * a hopeful "Downloaded!".
 */
export type SaveOutcome =
  | { kind: 'browser-download'; filename: string }
  | { kind: 'shared'; filename: string }
  | { kind: 'saved'; filename: string; location: string }
  | { kind: 'share-dismissed'; filename: string; location: string };

export class SaveFileError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SaveFileError';
    this.cause = cause;
  }
}

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Blob → base64, which is the only shape `Filesystem.writeFile` accepts.
 *
 * `FileReader` rather than `btoa(String.fromCharCode(...bytes))`: spreading a
 * multi-megabyte byte array into `String.fromCharCode` blows the argument-count
 * limit and throws on exactly the large export this exists to handle.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new SaveFileError('The file could not be read.', reader.error));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) {
        reject(new SaveFileError('The file could not be encoded for saving.'));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * `share` was cancelled by the user, as opposed to failing.
 *
 * Capacitor surfaces both as a rejection, and the difference matters: a
 * cancellation must not be reported as an error, because the file is already
 * safely on disk and telling the user the export failed would send them round
 * the loop again.
 */
function isShareDismissal(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('cancel') || message.includes('abort') || message.includes('dismiss');
}

/** Strips anything a filesystem or a Content-Disposition header could object to. */
function sanitizeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.\./g, '-')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

async function saveInBrowser(blob: Blob, filename: string): Promise<SaveOutcome> {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    // Kept out of the layout entirely: appending a visible element for one tick
    // can shift the page on a phone.
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { kind: 'browser-download', filename };
  } finally {
    // Revoked on the next frame rather than immediately: some browsers have not
    // finished reading the blob by the time `click()` returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function saveOnDevice(blob: Blob, filename: string): Promise<SaveOutcome> {
  const data = await blobToBase64(blob);

  // Cache first: it needs no storage permission on any Android version and is
  // reachable by the share sheet through the app's FileProvider.
  let uri: string;
  try {
    const written = await Filesystem.writeFile({
      path: filename,
      data,
      directory: Directory.Cache,
      recursive: true,
    });
    uri = written.uri;
  } catch (error) {
    throw new SaveFileError('The file could not be written to this device.', error);
  }

  try {
    const canShare = await Share.canShare().catch(() => ({ value: false }));
    if (!canShare.value) {
      return { kind: 'saved', filename, location: uri };
    }
    await Share.share({
      title: filename,
      // `files` is what makes the receiving app get the actual spreadsheet
      // rather than a link it cannot open.
      files: [uri],
      dialogTitle: 'Save or send the attendance sheet',
    });
    return { kind: 'shared', filename };
  } catch (error) {
    if (isShareDismissal(error)) {
      return { kind: 'share-dismissed', filename, location: uri };
    }
    // The bytes are on disk regardless; the share sheet is a convenience.
    return { kind: 'saved', filename, location: uri };
  }
}

/**
 * Hand a downloaded blob to the platform.
 *
 * On device this writes the file and opens the share sheet — a phone has no
 * "Downloads bar", so a file that is merely written is a file the user cannot
 * find. In a browser it goes through an object URL, because the export endpoint
 * needs an `Authorization` header and therefore cannot be a plain `<a href>`.
 */
export async function saveFile(
  blob: Blob,
  suggestedName: string | null,
  fallbackName: string,
): Promise<SaveOutcome> {
  const filename = sanitizeFilename(suggestedName ?? fallbackName, fallbackName);
  return isNative() ? saveOnDevice(blob, filename) : saveInBrowser(blob, filename);
}
