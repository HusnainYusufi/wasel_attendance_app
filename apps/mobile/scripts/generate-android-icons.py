#!/usr/bin/env python3
"""
Generate the Android launcher icon set from the Legend shield mark.

Run this only when the brand asset changes:

    python3 apps/mobile/scripts/generate-android-icons.py

The PNGs it writes are committed, and CI merely copies them into the generated
native project. That is deliberate: the Android project is regenerated on every
run, and making the build depend on an image library would add a toolchain (and
a failure mode) to every APK for the sake of an asset that changes once a year.

Requires Pillow, which is a local authoring dependency, not a build one.

Source note: the supplied logo is a 400x160 horizontal wordmark, of which the
shield is only 77x86 pixels. A launcher icon must be square, and a wide wordmark
shrunk into a square is illegible at 48dp, so only the shield is used. If a
higher-resolution or vector version of the mark ever turns up, replace
resources/legend-shield.png and re-run this — everything downstream follows.
"""

from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[3]
MOBILE = REPO / "apps" / "mobile"
SOURCE = MOBILE / "resources" / "legend-shield.png"
OUTPUT = MOBILE / "resources" / "android"

# The shield's interior is transparent, not white. On a dark background it very
# nearly disappears and the "L" stops reading, so the icon is set on white.
BACKGROUND = (255, 255, 255, 255)

# Legacy icons: the whole square is the icon, so the mark can be generous.
LEGACY_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
LEGACY_FRACTION = 0.68

# Adaptive icons (Android 8+): a 108dp canvas of which only the central 66dp
# (61%) survives whatever mask the launcher applies — circle, squircle, teardrop.
ADAPTIVE_SIZES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
# ~82% of the safe zone: visually substantial without risking a clipped edge.
ADAPTIVE_FRACTION = 0.50

PLAY_STORE_SIZE = 512


def compose(source: Image.Image, canvas_px: int, fraction: float, *, background=None, circle=False):
    """The shield centred on a square canvas, occupying `fraction` of its width."""
    if circle and background:
        canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
        ImageDraw.Draw(canvas).ellipse([0, 0, canvas_px - 1, canvas_px - 1], fill=background)
    else:
        canvas = Image.new("RGBA", (canvas_px, canvas_px), background or (0, 0, 0, 0))

    scale = min(
        canvas_px * fraction / source.width,
        canvas_px * fraction / source.height,
    )
    width = max(1, round(source.width * scale))
    height = max(1, round(source.height * scale))
    mark = source.resize((width, height), Image.LANCZOS)
    canvas.alpha_composite(mark, ((canvas_px - width) // 2, (canvas_px - height) // 2))
    return canvas


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing brand mark: {SOURCE}")

    source = Image.open(SOURCE).convert("RGBA")
    written = 0

    for density, size in LEGACY_SIZES.items():
        directory = OUTPUT / f"mipmap-{density}"
        directory.mkdir(parents=True, exist_ok=True)
        compose(source, size, LEGACY_FRACTION, background=BACKGROUND).save(
            directory / "ic_launcher.png"
        )
        compose(source, size, LEGACY_FRACTION, background=BACKGROUND, circle=True).save(
            directory / "ic_launcher_round.png"
        )
        written += 2

    for density, size in ADAPTIVE_SIZES.items():
        directory = OUTPUT / f"mipmap-{density}"
        directory.mkdir(parents=True, exist_ok=True)
        compose(source, size, ADAPTIVE_FRACTION).save(directory / "ic_launcher_foreground.png")
        written += 1

    compose(source, PLAY_STORE_SIZE, LEGACY_FRACTION, background=BACKGROUND).save(
        OUTPUT / "play-store-512.png"
    )
    written += 1

    print(f"Wrote {written} files to {OUTPUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
