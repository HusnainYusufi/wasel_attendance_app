import type { CapacitorConfig } from '@capacitor/cli';

/**
 * `android/` is generated in CI (`npx cap add android`), never committed — the
 * build machine owns the Gradle/SDK toolchain. Everything the generator needs
 * lives in this file.
 */
const config: CapacitorConfig = {
  // Changing appId after a Play Store release is impossible — the package name
  // is the app's permanent identity there. Rebranding before publication is the
  // only cheap moment to do it. Note that a device treats a new appId as a
  // different app: the old build must be uninstalled, not upgraded over.
  appId: 'com.legend.attendance',
  appName: 'Legend Attendance',
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
