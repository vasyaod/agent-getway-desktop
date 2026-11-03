#!/usr/bin/env python3
"""Makes every icon the app ships from resources/icon.png (the Getway Chat registry PNG).

    python3 scripts/make-icons.py      # needs Pillow; commit the result

The app icon is drawn here, from the registry PNG's bubble, on a tile with a top-to-bottom
gradient of the brand colour; the bubble casts a soft shadow on it:

build/icon.icns       macOS, Apple's icon grid: a squircle 824 px wide on a 1024 px canvas, 100 px
                      of transparent padding around it and a drop shadow below it, so it is as big
                      as its Dock neighbours. 16 to 512 pt, @1x and @2x
build/icon-mac.png    the same at 1024x1024, to look at
build/icon.ico        Windows, 16 to 256 px: the tile almost full-bleed, no shadow
build/icon.png        512x512, the same for Linux; electron-builder makes the Linux sizes from it
src/assets/icon.png   256x256, the window and notification icon (Windows, Linux)
src/assets/tray*.png  the Windows/Linux tray icon: the bubble glyph in white on transparent, 16 px,
                      @1.5x and @2x; tray-unread*.png is the solid bubble with a badge cut out
src/assets/tray*Template*.png  the same glyphs in black for the macOS menu bar, which tints a
                      template image for light and dark mode; 16 px and @2x
src/assets/overlay-unread.png  the Windows taskbar overlay while replies are unread
"""
import hashlib
import io
import json
import math
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "resources" / "icon.png"
brand = json.loads((ROOT / "resources" / "brand.json").read_text())
assert hashlib.sha256(SRC.read_bytes()).hexdigest() == brand["sha256"], "icon.png drifted from brand.json"

icon = Image.open(SRC).convert("RGBA")
assets = ROOT / "src" / "assets"
assets.mkdir(parents=True, exist_ok=True)
(ROOT / "build").mkdir(exist_ok=True)

UNREAD = (229, 57, 53, 255)  # the overlay dot: red, with a white ring so it reads on any taskbar

# The bubble and the tray glyph are drawn, not downscaled from the 512 px PNG, so its edges and dots land on whole
# pixels at 16 px. Its shape is measured on resources/icon.png, in that PNG's pixels: the body
# of the bubble, its corner radius, the tail (top edge width and tip) and the three dots.
BODY = (100, 116, 412, 344)
RADIUS = 62
TAIL = (157, 240, (150, 397))  # top edge from x to x, then the tip
TAIL_SCALE = 1.3  # a longer tail than the PNG's, which is a sliver at 16 px
DOT_X = (185.5, 255.5, 325.5)
DOT_D = 45
BRAND = (41, 182, 209)  # brand.json "color"
SS = 16  # supersampling: drawn at 16x, then box-filtered down


def squircle(draw, box, fill):
    """Apple's app icon shape, near enough: straight sides and continuous corners. Each corner is
    a quarter superellipse (n=3.26) 34.4% of the side wide, as deep at 45 degrees as the 185 px
    circular corner of an 824 px icon, and with no jump in curvature where it meets the side."""
    l, t, r, b = box
    c, n = 0.344 * (r - l), 3.26
    pts = []
    for cx, cy, a0 in ((r - c, t + c, -90), (r - c, b - c, 0), (l + c, b - c, 90), (l + c, t + c, 180)):
        for i in range(361):
            th = math.radians(a0 + i / 4)
            co, si = math.cos(th), math.sin(th)
            pts.append((cx + c * math.copysign(abs(co) ** (2 / n), co), cy + c * math.copysign(abs(si) ** (2 / n), si)))
    draw.polygon(pts, fill=fill)


def gradient(size, top, bottom, y0, y1):
    """A vertical gradient from `top` at y0 to `bottom` at y1, `size` px square."""
    col = Image.new("RGB", (1, 256))
    for y in range(256):
        col.putpixel((0, y), tuple(round(a + (b - a) * y / 255) for a, b in zip(top, bottom)))
    col = col.resize((1, max(1, round(y1 - y0))), Image.BILINEAR)
    img = Image.new("RGB", (size, size), top)
    img.paste(col.resize((size, col.height)), (0, round(y0)))
    img.paste(Image.new("RGB", (size, max(0, size - round(y1))), bottom), (0, round(y1)))
    return img


def app_icon(inset, shadow, k=4096):
    """The app icon at `k` px: the tile `inset` px of 1024 in from each edge, the bubble on it, and
    for `shadow` the tile's drop shadow (Apple's template: 10 px down, 10 px blur, 30% black)."""
    u = k / 1024
    L, R = inset * u, k - inset * u
    w = R - L
    out = Image.new("RGBA", (k, k), (0, 0, 0, 0))
    tile = Image.new("L", (k, k), 0)
    squircle(ImageDraw.Draw(tile), (L, L, R, R), 255)
    if shadow:
        sh = Image.new("L", (k, k), 0)
        squircle(ImageDraw.Draw(sh), (L, L + 10 * u, R, R + 10 * u), 77)
        sh = sh.filter(ImageFilter.GaussianBlur(10 * u))
        out = Image.composite(Image.new("RGBA", (k, k), (0, 0, 0, 255)), out, sh)
        out.putalpha(sh)
    out.paste(gradient(k, (92, 212, 233), (22, 150, 182), L, R), (0, 0), tile)

    # The bubble, in the registry PNG's pixels (512 for the tile's width), with its tail and dots.
    p = lambda x, y: (L + x * w / 512, L + y * w / 512)
    bubble = Image.new("L", (k, k), 0)
    d = ImageDraw.Draw(bubble)
    d.rounded_rectangle(p(BODY[0], BODY[1]) + p(BODY[2], BODY[3]), radius=RADIUS * w / 512, fill=255)
    d.polygon([p(155.5, 330), p(238, 330), p(162.5, 394.5), p(149.6, 389)], fill=255)
    tip, tr = p(157, 389), 7.5 * w / 512
    d.ellipse((tip[0] - tr, tip[1] - tr, tip[0] + tr, tip[1] + tr), fill=255)

    # Its shadow on the tile: 6 px down, soft, a dark teal; only on the tile.
    sh = Image.new("L", (k, k), 0)
    sh.paste(bubble, (0, round(6 * w / 512)))
    sh = sh.filter(ImageFilter.GaussianBlur(9 * w / 512)).point(lambda a: a * 0.32)
    sh = ImageChops.multiply(sh, tile)
    out.paste(Image.new("RGBA", (k, k), (0, 60, 80, 255)), (0, 0), sh)

    top, bottom = p(0, BODY[1])[1], p(0, BODY[3])[1]
    out.paste(gradient(k, (255, 255, 255), (226, 243, 248), top, bottom), (0, 0), bubble)
    d = ImageDraw.Draw(out)
    cy, r = p(0, (BODY[1] + BODY[3]) / 2)[1], DOT_D / 2 * w / 512
    for x in DOT_X:
        cx = p(x, 0)[0]
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=BRAND + (255,))
    return out


def sizes(art, pxs):
    return {px: art.resize((px, px), Image.LANCZOS) for px in pxs}


# The .icns entries: (type, px). icp4/icp5 are 16 and 32 pt; ic11 to ic14 are 16 to 256 pt @2x,
# ic07 to ic10 are 128 to 512 pt (ic10 is 512 pt @2x), all PNG inside.
ICNS = [("icp4", 16), ("icp5", 32), ("ic11", 32), ("ic12", 64), ("ic07", 128), ("ic13", 256),
        ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024)]


def write_icns(path, images):
    """An .icns of PNG entries, with its table of contents (Pillow's writer has no 16/32 pt @1x)."""
    chunks = []
    for kind, px in ICNS:
        buf = io.BytesIO()
        images[px].save(buf, "PNG")
        chunks.append(kind.encode() + struct.pack(">I", 8 + len(buf.getvalue())) + buf.getvalue())
    toc = b"TOC " + struct.pack(">I", 8 + 8 * len(chunks)) + b"".join(c[:8] for c in chunks)
    body = toc + b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)


mac = sizes(app_icon(100, shadow=True), {px for _, px in ICNS})
write_icns(ROOT / "build" / "icon.icns", mac)
mac[1024].save(ROOT / "build" / "icon-mac.png")

ICO = (16, 24, 32, 48, 64, 128, 256)
flat = sizes(app_icon(16, shadow=False), set(ICO) | {512})
flat[256].save(ROOT / "build" / "icon.ico", sizes=[(px, px) for px in ICO],
               append_images=[flat[px] for px in ICO[:-1]])
flat[512].save(ROOT / "build" / "icon.png")
flat[256].save(assets / "icon.png")


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
