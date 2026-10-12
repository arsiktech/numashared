#!/usr/bin/env python3
"""Compare an approved design frame with an actual native screenshot.

Analysis only: no generated UI, registration warping, selective erasure, or pass
threshold. Preserve originals, normalize their raster scale, and report differences.
Requires Pillow. Native capture must match the logical viewport; documented XCTest rounding may differ by one raster pixel.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageCms, ImageDraw, ImageStat


def srgb(path, untagged_profile=None):
    image = Image.open(path)
    image.load()
    profile = image.info.get("icc_profile")
    if profile or untagged_profile:
        image = ImageCms.profileToProfile(
            image.convert("RGB"), (ImageCms.ImageCmsProfile(io.BytesIO(profile)) if profile
                                   else ImageCms.ImageCmsProfile(str(untagged_profile))),
            ImageCms.createProfile("sRGB"), outputMode="RGB")
    elif image.mode != "RGB":
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, "white")
        image = Image.alpha_composite(background, rgba).convert("RGB")
    return image


def delta_metrics(reference, native):
    diff = ImageChops.difference(reference, native)
    stat = ImageStat.Stat(diff)
    red, green, blue = diff.split()
    histogram = ImageChops.lighter(ImageChops.lighter(red, green), blue).histogram()
    count = diff.width * diff.height
    return diff, {
        "meanAbsoluteRGBDelta255": round(sum(stat.mean) / 3, 4),
        "pixelCount": count,
        "differentPixelPercent": round(100 * sum(histogram[1:]) / count, 4),
        "pixelPercentMaxChannelDeltaAbove8": round(100 * sum(histogram[9:]) / count, 4),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("native", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--width", type=int, default=393)
    parser.add_argument("--height", type=int, default=852)
    parser.add_argument("--scale", type=int, default=3)
    parser.add_argument("--state", required=True)
    parser.add_argument("--reference-profile", type=Path,
                        help="Explicit source ICC profile for an untagged reference; requires calibration evidence")
    args = parser.parse_args()
    if min(args.width, args.height, args.scale) < 1:
        parser.error("Viewport and scale must be positive")
    reference, native = srgb(args.reference, args.reference_profile), srgb(args.native)
    reference_size, native_size = reference.size, native.size
    expected = args.width * args.scale, args.height * args.scale
    raster_rounding = [native.width - expected[0], native.height - expected[1]]
    if any(abs(delta) > 1 for delta in raster_rounding):
        parser.error(f"Native capture {native.size} is not viewport {expected} (at most one raster pixel rounding); recapture, do not stretch it")
    expected = native.size  # Preserve actual native pixels; never resize native output.
    # Browser frame export can have subpixel width rounding. Only raster scale is normalized.
    if abs(reference.width / reference.height - args.width / args.height) > 0.002:
        parser.error("Reference aspect ratio differs; identify the correct full frame before comparison")
    reference = reference.resize(expected, Image.Resampling.LANCZOS)
    diff, full_metrics = delta_metrics(reference, native)
    # This additional region separates OS status/home-indicator chrome. Full frame
    # remains reported and visible; no app pixels are removed from the artifacts.
    app_rect = (0, 59 * args.scale, expected[0], (args.height - 34) * args.scale)
    _, app_metrics = delta_metrics(reference.crop(app_rect), native.crop(app_rect))
    args.output.mkdir(parents=True, exist_ok=True)
    reference.save(args.output / "reference-normalized.png")
    native.save(args.output / "native-srgb.png")
    Image.blend(reference, native, 0.5).save(args.output / "overlay-50.png")
    diff.point(lambda channel: min(255, channel * 4)).save(args.output / "difference-x4.png")
    header = 32 * args.scale
    board = Image.new("RGB", (expected[0] * 2, expected[1] + header), "#e5e6e2")
    board.paste(reference, (0, header))
    board.paste(native, (expected[0], header))
    draw = ImageDraw.Draw(board)
    draw.text((18, 18), "APPROVED REFERENCE", fill="#252b27", font_size=28)
    draw.text((expected[0] + 18, 18), "ACTUAL NATIVE", fill="#252b27", font_size=28)
    board.save(args.output / "side-by-side.png")
    receipt = {
        "state": args.state,
        "verdict": "REQUIRES_VISUAL_REVIEW",
        "reference": str(args.reference.resolve()),
        "native": str(args.native.resolve()),
        "sha256": {"reference": hashlib.sha256(args.reference.read_bytes()).hexdigest(),
                   "native": hashlib.sha256(args.native.read_bytes()).hexdigest()},
        "originalPixels": {"reference": reference_size, "native": native_size},
        "logicalViewport": [args.width, args.height], "scale": args.scale,
        "nativeRasterRoundingPixels": raster_rounding,
        "explicitUntaggedReferenceProfile": str(args.reference_profile) if args.reference_profile else None,
        "normalization": "ICC conversion to sRGB; uniform reference raster resize only; native untouched in size",
        "fullFrame": full_metrics,
        "applicationRegion": {"rectanglePixels": app_rect, **app_metrics},
        "limitations": ["No automatic pass: font rasterization and system chrome differ between web and native.",
                        "Matching fixture, locale, text size, date and state require independent verification.",
                        "No content masks, translations, elastic registration or app-layout cropping were used."],
    }
    (args.output / "comparison.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
