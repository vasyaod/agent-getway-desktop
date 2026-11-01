#!/usr/bin/env python3
"""Makes every icon the app ships from resources/icon.png (the Getway Chat registry PNG).

    python3 scripts/make-icons.py      # needs Pillow; commit the result

build/icon.png        512x512, electron-builder makes the .icns/.ico and Linux sizes from it
src/assets/icon.png   256x256, the window icon
src/assets/tray*.png  the tray icon, 16 px and @2x; tray-unread*.png adds the unread dot
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

UNREAD = (229, 57, 53, 255)  # the dot: red, with a white ring so it reads on the brand colour


def dot(size, img=None):
    img = img.copy() if img is not None else Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = max(3, size * 7 // 32)
    ring = max(1, size // 16)
    box = (size - 2 * r - 1, 0, size - 1, 2 * r)
    d.ellipse(box, fill=(255, 255, 255, 255))
    d.ellipse((box[0] + ring, box[1] + ring, box[2] - ring, box[3] - ring), fill=UNREAD)
    return img


for scale, suffix in ((1, ""), (2, "@2x")):
    size = 16 * scale
    tray = icon.resize((size, size), Image.LANCZOS)
    tray.save(assets / f"tray{suffix}.png")
    dot(size, tray).save(assets / f"tray-unread{suffix}.png")

overlay = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)
d.ellipse((0, 0, 15, 15), fill=(255, 255, 255, 255))
d.ellipse((2, 2, 13, 13), fill=UNREAD)
overlay.save(assets / "overlay-unread.png")
print("icons written")
