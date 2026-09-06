import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/**
 * Haptic confirmation for the punch.
 *
 * A check-in happens outdoors, one-handed, often with the screen barely visible
 * in the sun. The buzz is frequently the *first* confirmation the user gets that
 * the tap registered, so it fires on success and on failure with different
 * patterns — a success that feels like a failure is worse than no feedback.
 *
 * Every call is fire-and-forget and swallows its own errors: an OEM WebView that
 * rejects the vibrator must never take down the screen that just succeeded. The
 * plugin is a no-op in the browser, so no platform guard is needed for
 * correctness — only to avoid the pointless bridge call.
 */

function available(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function hapticSuccess(): void {
  if (!available()) return;
  void Haptics.notification({ type: NotificationType.Success }).catch(() => undefined);
}

export function hapticWarning(): void {
  if (!available()) return;
  void Haptics.notification({ type: NotificationType.Warning }).catch(() => undefined);
}

export function hapticError(): void {
  if (!available()) return;
  void Haptics.notification({ type: NotificationType.Error }).catch(() => undefined);
}

/** A light tick for a committing tap, before the network round trip resolves. */
export function hapticTap(): void {
  if (!available()) return;
  void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => undefined);
}
