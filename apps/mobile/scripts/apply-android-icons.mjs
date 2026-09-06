#!/usr/bin/env node
/**
 * Install the Legend launcher icons into the generated Android project.
 *
 * `apps/mobile/android/` is a build artifact — `cap add android` recreates it on
 * every CI run, complete with Capacitor's default placeholder icon. Without this
 * step the APK ships that placeholder no matter what is in `resources/`.
 *
 * Only copying happens here. The PNGs are generated once by
 * `generate-android-icons.py` and committed, so the APK build needs no image
 * toolchain and cannot fail on one.
 *
 * Idempotent, and fails loudly rather than shipping the wrong brand.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const source = join(mobile, 'resources', 'android');
const res = join(mobile, 'android', 'app', 'src', 'main', 'res');

if (!existsSync(source)) {
  console.error(`\nNo generated icons at:\n  ${source}\n`);
  console.error('Run: python3 apps/mobile/scripts/generate-android-icons.py\n');
  process.exit(1);
}

if (!existsSync(res)) {
  console.error(`\nNo Android resources directory at:\n  ${res}\n`);
  console.error('Run `npx cap add android` first — the native project is generated.\n');
  process.exit(1);
}

let copied = 0;
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('mipmap-')) continue;
  const target = join(res, entry.name);
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(join(source, entry.name))) {
    if (!file.endsWith('.png')) continue;
    copyFileSync(join(source, entry.name, file), join(target, file));
    copied += 1;
  }
}

if (copied === 0) {
  console.error('\nFound no PNGs to copy — refusing to leave the placeholder icon in place.\n');
  process.exit(1);
}

/**
 * The adaptive-icon descriptors (Android 8+). Written rather than assumed:
 * Capacitor's defaults reference a vector foreground, and leaving those in place
 * would keep the placeholder on every modern launcher while the legacy PNGs —
 * used only by Android 7 and older — showed the real brand.
 */
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;

const anydpi = join(res, 'mipmap-anydpi-v26');
mkdirSync(anydpi, { recursive: true });
writeFileSync(join(anydpi, 'ic_launcher.xml'), adaptive);
writeFileSync(join(anydpi, 'ic_launcher_round.xml'), adaptive);

// White, because the shield's interior is transparent: on a dark background the
// outline merges into it and the "L" stops reading at launcher size.
const values = join(res, 'values');
mkdirSync(values, { recursive: true });
writeFileSync(
  join(values, 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FFFFFF</color>
</resources>
`,
);

console.log(`Installed ${copied} launcher PNGs, adaptive descriptors and the background colour.`);
