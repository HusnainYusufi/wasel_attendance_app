import type { CapacitorConfig } from '@capacitor/cli';

/**
 * `android/` is generated in CI (`npx cap add android`), never committed — the
 * build machine owns the Gradle/SDK toolchain. Everything the generator needs
 * lives in this file.
 */
const config: CapacitorConfig = {
  appId: 'com.wasel.attendance',
  appName: 'Wasel Attendance',
  webDir: 'dist',
  android: {
    // Keeps the WebView background from flashing white before the app paints.
    backgroundColor: '#05070C',
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#05070C',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    StatusBar: {
      // The app shell paints its own safe-area strip, so the status bar is
      // transparent and content flows beneath it.
      overlaysWebView: true,
      style: 'DEFAULT',
    },
  },
};

export default config;
