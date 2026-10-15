"""Generates build/icon.icns and docs/logo.png. macOS only (uses sips + iconutil).

Needs Pillow, which is not a project dependency:
    python3 -m venv /tmp/iconenv && /tmp/iconenv/bin/pip install pillow
    /tmp/iconenv/bin/python scripts/gen_icon.py
"""
import math
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 2                      # supersample factor for smooth edges
SIZE = 1024 * SS
S = SS

TOP = (255, 176, 32)        # amber  (#ffb020)
BOTTOM = (232, 51, 95)      # rose   (#e8335f), the app's accent
TILE_TOP = (28, 30, 36)
TILE_BOTTOM = (11, 12, 15)
SEAM = (14, 15, 19, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(top, bottom):
    strip = Image.new("RGB", (1, SIZE))
    for y in range(SIZE):
        strip.putpixel((0, y), lerp(top, bottom, y / (SIZE - 1)))
    return strip.resize((SIZE, SIZE))


def diagonal_gradient(c1, c2):
    small = 256
    img = Image.new("RGB", (small, small))
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2 * (small - 1))
            img.putpixel((x, y), lerp(c1, c2, min(1.0, max(0.0, (t - 0.28) / 0.44))))
    return img.resize((SIZE, SIZE), Image.BILINEAR)


def mark_mask():
    """Alpha mask of the mark: an open 'C' ring wrapping a basketball."""
    m = Image.new("L", (SIZE, SIZE), 0)
    d = ImageDraw.Draw(m)
    c = SIZE // 2
    outer, thick = 300 * S, 92 * S
    d.arc([c - outer, c - outer, c + outer, c + outer], start=42, end=318, fill=255, width=thick)
    mid = outer - thick // 2
    for ang in (42, 318):
        ex = c + mid * math.cos(math.radians(ang))
        ey = c + mid * math.sin(math.radians(ang))
        d.ellipse([ex - thick // 2, ey - thick // 2, ex + thick // 2, ey + thick // 2], fill=255)

    bx, br = c + 22 * S, 126 * S
    d.ellipse([bx - br, c - br, bx + br, c + br], fill=255)
    return m, (bx, c, br)


def seam_mask(ball):
    bx, by, br = ball
    m = Image.new("L", (SIZE, SIZE), 0)
    d = ImageDraw.Draw(m)
    w = 13 * S
    d.line([bx, by - br, bx, by + br], fill=255, width=w)
    d.line([bx - br, by, bx + br, by], fill=255, width=w)
    for sign in (-1, 1):
        cx = bx + sign * int(br * 1.15)
        d.ellipse([cx - br, by - br, cx + br, by + br], outline=255, width=w)
    clip = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(clip).ellipse([bx - br, by - br, bx + br, by + br], fill=255)
    return ImageChops.multiply(m, clip)


def build():
    tile_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=255)

    img = vertical_gradient(TILE_TOP, TILE_BOTTOM).convert("RGBA")

    mask, ball = mark_mask()
    grad = diagonal_gradient(TOP, BOTTOM).convert("RGBA")

    glow = Image.new("RGBA", (SIZE, SIZE), BOTTOM + (0,))
    glow.putalpha(mask.filter(ImageFilter.GaussianBlur(46 * S)).point(lambda v: int(v * 0.55)))
    img = Image.alpha_composite(img, glow)

    img.paste(grad, (0, 0), mask)
    seams = Image.new("RGBA", (SIZE, SIZE), SEAM)
    img.paste(seams, (0, 0), seam_mask(ball))

    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, (0, 0), tile_mask)
    return out.resize((1024, 1024), Image.LANCZOS)


def write_icns(png_1024):
    tmp = tempfile.mkdtemp()
    iconset = os.path.join(tmp, "icon.iconset")
    os.makedirs(iconset)
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = base * scale
            name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
            png_1024.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ROOT, "build", "icon.icns")], check=True)
    shutil.rmtree(tmp)


if __name__ == "__main__":
    icon = build()
    write_icns(icon)
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "docs", "logo.png"))
    print("wrote build/icon.icns and docs/logo.png")
