#!/usr/bin/env python3
"""Create a visible pixel-difference image and a machine-readable summary."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageOps


def fail(message: str) -> None:
    raise SystemExit(message)


if len(sys.argv) != 5:
    fail(
        "usage: visual_pixel_diff.py "
        "<reference.png> <implementation.png> <diff.png> <threshold>"
    )

reference_path = Path(sys.argv[1])
implementation_path = Path(sys.argv[2])
diff_path = Path(sys.argv[3])
threshold = int(sys.argv[4])

reference = Image.open(reference_path).convert("RGBA")
implementation = Image.open(implementation_path).convert("RGBA")
if reference.size != implementation.size:
    fail(
        f"screenshot size mismatch: reference={reference.size}, "
        f"implementation={implementation.size}"
    )

raw_diff = ImageChops.difference(reference, implementation).convert("RGB")
red, green, blue = raw_diff.split()


def threshold_band(band: Image.Image) -> Image.Image:
    return band.point(lambda value: 255 if value > threshold else 0)


changed_mask = ImageChops.lighter(
    threshold_band(red),
    ImageChops.lighter(threshold_band(green), threshold_band(blue)),
)
histogram = changed_mask.histogram()
changed_pixels = histogram[255]
total_pixels = reference.width * reference.height
changed_bbox = changed_mask.getbbox()

context = ImageOps.grayscale(reference.convert("RGB")).convert("RGB")
context = ImageEnhance.Brightness(context).enhance(0.45)
highlight = Image.new("RGB", reference.size, (255, 35, 35))
visible_diff = Image.composite(highlight, context, changed_mask)
diff_path.parent.mkdir(parents=True, exist_ok=True)
visible_diff.save(diff_path)

print(
    json.dumps(
        {
            "width": reference.width,
            "height": reference.height,
            "threshold": threshold,
            "changed_pixels": changed_pixels,
            "total_pixels": total_pixels,
            "changed_pixel_ratio": changed_pixels / total_pixels if total_pixels else 0,
            "changed_bbox": list(changed_bbox) if changed_bbox else None,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
)
