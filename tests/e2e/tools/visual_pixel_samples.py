#!/usr/bin/env python3
"""Read exact RGBA samples from a screenshot and print machine-readable JSON."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image


def fail(message: str) -> None:
    raise SystemExit(message)


if len(sys.argv) != 4:
    fail("usage: visual_pixel_samples.py <image.png> <x> <y1,y2,...>")

image_path = Path(sys.argv[1])
x = int(sys.argv[2])
try:
    sample_y = [int(value) for value in sys.argv[3].split(",") if value]
except ValueError as error:
    fail(f"invalid y coordinate list: {error}")

if not sample_y:
    fail("at least one y coordinate is required")

image = Image.open(image_path).convert("RGBA")
if x < 0 or x >= image.width:
    fail(f"x coordinate {x} is outside image width {image.width}")

samples: list[dict[str, object]] = []
for y in sample_y:
    if y < 0 or y >= image.height:
        fail(f"y coordinate {y} is outside image height {image.height}")
    rgba = list(image.getpixel((x, y)))
    samples.append({"y": y, "rgb": rgba[:3], "rgba": rgba})

print(
    json.dumps(
        {
            "image": str(image_path),
            "width": image.width,
            "height": image.height,
            "x": x,
            "samples": samples,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
)
