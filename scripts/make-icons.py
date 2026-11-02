#!/usr/bin/env python3
"""Makes every icon the app ships from resources/icon.png (the Getway Chat registry PNG).

    python3 scripts/make-icons.py      # needs Pillow; commit the result

build/icon.png        512x512, electron-builder makes the .icns/.ico and Linux sizes from it
src/assets/icon.png   256x256, the window icon
src/assets/tray*.png  the Windows/Linux tray icon: the bubble glyph in white on transparent, 16 px,
                      @1.5x and @2x; tray-unread*.png is the solid bubble with a badge cut out
src/assets/tray*Template*.png  the same glyphs in black for the macOS menu bar, which tints a
                      template image for light and dark mode; 16 px and @2x
src/assets/overlay-unread.png  the Windows taskbar overlay while replies are unread
"""
import json
import hashlib
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "resources" / "icon.png"
brand = json.loads((ROOT / "resources" / "brand.json").read_text())
assert hashlib.sha256(SRC.read_bytes()).hexdigest() == brand["sha256"], "icon.png drifted from brand.json"

icon = Image.open(SRC).convert("RGBA")
assets = ROOT / "src" / "assets"
assets.mkdir(parents=True, exist_ok=True)
(ROOT / "build").mkdir(exist_ok=True)

icon.resize((512, 512), Image.LANCZOS).save(ROOT / "build" / "icon.png")
icon.resize((256, 256), Image.LANCZOS).save(assets / "icon.png")

UNREAD = (229, 57, 53, 255)  # the overlay dot: red, with a white ring so it reads on any taskbar

# The tray glyph is drawn, not downscaled from the 512 px PNG, so its edges and dots land on whole
# pixels at 16 px. Its shape is measured on resources/icon.png, in that PNG's pixels: the body
# of the bubble, its corner radius, the tail (top edge width and tip) and the three dots.
BODY = (100, 116, 412, 344)
RADIUS = 62
TAIL = (157, 240, (150, 397))  # top edge from x to x, then the tip
TAIL_SCALE = 1.3  # a longer tail than the PNG's, which is a sliver at 16 px
DOT_X = (185.5, 255.5, 325.5)
DOT_D = 45
SS = 16  # supersampling: drawn at 16x, then box-filtered down


def tray_glyph(size, unread):
    """The tray glyph's alpha mask at `size` px: the bubble with its three dots cut out, or for
    `unread` the solid bubble with a badge in its top right corner, cut free by a ring."""
    margin = round(size / 16)
    s = (size - 2 * margin) / (BODY[2] - BODY[0])
    d = max(2, round(DOT_D * s))
    w = size - 2 * margin
    w -= (w - d) % 2  # the dots sit on whole pixels: body and dot widths share a parity
    h = d + 2 * round(((BODY[3] - BODY[1]) * s - d) / 2)
    gap = max(d + 1, round((DOT_X[1] - DOT_X[0]) * s))
    tail_h = (TAIL[2][1] - BODY[3]) * TAIL_SCALE * s
    x0, y0 = margin, round((size - h - tail_h) / 2)

    k = SS
    img = Image.new("L", (size * k, size * k), 0)
    draw = ImageDraw.Draw(img)
    box = lambda l, t, r, b: (l * k, t * k, r * k - 1, b * k - 1)
    draw.rounded_rectangle(box(x0, y0, x0 + w, y0 + h), radius=RADIUS * s * k, fill=255)
    tx = lambda x: x0 + (x - BODY[0]) * s
    bottom = y0 + h
    draw.polygon([(tx(TAIL[0]) * k, (bottom - 1) * k),
                  (tx(TAIL[0] + (TAIL[1] - TAIL[0]) * TAIL_SCALE) * k, (bottom - 1) * k),
                  (tx(TAIL[2][0]) * k, (bottom + tail_h) * k)], fill=255)
    if unread:
        r = size * 3 / 16
        ring = max(1, round(size / 16))
        cx, cy = size - r, r
        draw.ellipse(box(cx - r - ring, cy - r - ring, cx + r + ring, cy + r + ring), fill=0)
        draw.ellipse(box(cx - r, cy - r, cx + r, cy + r), fill=255)
    else:
        cx, cy = x0 + w / 2, y0 + h / 2
        for i in (-1, 0, 1):
            draw.ellipse(box(cx + i * gap - d / 2, cy - d / 2, cx + i * gap + d / 2, cy + d / 2), fill=0)
    return img.resize((size, size), Image.BOX)


def tinted(mask, rgb):
    img = Image.new("RGBA", mask.size, rgb + (0,))
    img.putalpha(mask)
    return img


for unread in (False, True):
    name = "tray-unread" if unread else "tray"
    for scale, suffix in ((1, ""), (1.5, "@1.5x"), (2, "@2x")):
        mask = tray_glyph(round(16 * scale), unread)
        tinted(mask, (255, 255, 255)).save(assets / f"{name}{suffix}.png")
        if scale != 1.5:  # macOS displays are 1x or 2x
            tinted(mask, (0, 0, 0)).save(assets / f"{name}Template{suffix}.png")

overlay = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)
d.ellipse((0, 0, 15, 15), fill=(255, 255, 255, 255))
d.ellipse((2, 2, 13, 13), fill=UNREAD)
overlay.save(assets / "overlay-unread.png")
print("icons written")
