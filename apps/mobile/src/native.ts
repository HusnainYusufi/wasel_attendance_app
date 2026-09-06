import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

/**
 * Native shell setup, run once before React mounts.
 *
 * Every call is guarded by `isNativePlatform()`: in the browser these plugins
 * are unimplemented and would throw on the very first line of the app.
 */
export async function initNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    // The web layer draws its own safe-area padding, so the status bar is
    // transparent and content flows beneath it. `Style.Default` lets Android
    // pick icon colour from the system theme.
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setStyle({ style: Style.Default });
  } catch {
    // Not fatal: a status bar that stays opaque is cosmetic, and some OEM
    // WebViews reject the call outright.
  }

  try {
    // Hidden here rather than automatically, so the splash covers the moment
    // between first paint and the session restore resolving.
    await SplashScreen.hide();
  } catch {
    // Splash already hidden or unavailable.
  }
}
