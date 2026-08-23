#!/usr/bin/env python3
"""为尺寸可能不同的真实组件截图生成可见像素差异。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageOps


if len(sys.argv) != 5:
    raise SystemExit("usage: helper.py <reference> <current> <diff> <threshold>")

reference_path = Path(sys.argv[1])
current_path = Path(sys.argv[2])
diff_path = Path(sys.argv[3])
threshold = int(sys.argv[4])

reference_source = Image.open(reference_path).convert("RGBA")
current_source = Image.open(current_path).convert("RGBA")
canvas_size = (
    max(reference_source.width, current_source.width),
    max(reference_source.height, current_source.height),
)


def pad(source: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", canvas_size, (255, 255, 255, 0))
    canvas.alpha_composite(source, (0, 0))
    return canvas


reference = pad(reference_source)
current = pad(current_source)
raw = ImageChops.difference(reference, current).convert("RGB")
red, green, blue = raw.split()


def threshold_band(band: Image.Image) -> Image.Image:
    return band.point(lambda value: 255 if value > threshold else 0)


mask = ImageChops.lighter(
    threshold_band(red), ImageChops.lighter(threshold_band(green), threshold_band(blue))
)
histogram = mask.histogram()
changed_pixels = histogram[255]
total_pixels = canvas_size[0] * canvas_size[1]
context = ImageOps.grayscale(reference.convert("RGB")).convert("RGB")
context = ImageEnhance.Brightness(context).enhance(0.45)
visible = Image.composite(Image.new("RGB", canvas_size, (255, 35, 35)), context, mask)
diff_path.parent.mkdir(parents=True, exist_ok=True)
visible.save(diff_path)

print(
    json.dumps(
        {
            "reference_size": list(reference_source.size),
            "current_size": list(current_source.size),
            "canvas_size": list(canvas_size),
            "threshold": threshold,
            "changed_pixels": changed_pixels,
            "total_pixels": total_pixels,
            "changed_pixel_ratio": changed_pixels / total_pixels if total_pixels else 0,
            "changed_bbox": list(mask.getbbox()) if mask.getbbox() else None,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
)
