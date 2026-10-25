"""Generates docs/social-preview.png (1280x640), the image GitHub shows when the
repo link is shared. Upload it in the repo's Settings > Social preview.

Needs Pillow (not a project dependency):
    python3 -m venv /tmp/iconenv && /tmp/iconenv/bin/pip install pillow
    /tmp/iconenv/bin/python scripts/gen_social_preview.py
"""
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1280, 640
AMBER, ROSE = (255, 176, 32), (232, 51, 95)

BOLD = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]
REGULAR = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]


def font(paths, size):
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


bg = Image.new("RGB", (W, H))
px = bg.load()
for y in range(H):
    t = y / (H - 1)
    for x in range(W):
        px[x, y] = (int(22 - 11 * t), int(24 - 12 * t), int(28 - 13 * t))
bg = bg.convert("RGBA")

for color, center, radius in ((ROSE, (1100, 560), 360), (AMBER, (120, 40), 300)):
    glow = Image.new("RGBA", (W, H), color + (0,))
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).ellipse([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius], fill=70)
    glow.putalpha(mask.filter(ImageFilter.GaussianBlur(120)))
    bg = Image.alpha_composite(bg, glow)

shot = Image.open(os.path.join(ROOT, "docs", "screenshots", "home.png")).convert("RGB")
sw = 760
shot = shot.resize((sw, int(shot.height * sw / shot.width)), Image.LANCZOS).crop((0, 0, sw, 470))
card = rounded(shot, 22)
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
shadow.paste((0, 0, 0, 170), (600 + 8, 95 + 18, 600 + 8 + card.width, 95 + 18 + card.height))
bg = Image.alpha_composite(bg, shadow.filter(ImageFilter.GaussianBlur(26)))
bg.alpha_composite(card, (600, 95))

logo = Image.open(os.path.join(ROOT, "docs", "logo.png")).convert("RGBA").resize((128, 128), Image.LANCZOS)
bg.alpha_composite(logo, (80, 80))

d = ImageDraw.Draw(bg)
d.text((80, 232), "CourtSide", font=font(BOLD, 96), fill=(236, 236, 238))
for i, line in enumerate(["Every game, one place.", "Spoiler-safe skip to the", "quarter that matters."]):
    d.text((84, 356 + i * 44), line, font=font(REGULAR, 32), fill=(170, 171, 180))
d.text((84, 524), "NBA · Premier League · Champions League", font=font(BOLD, 21), fill=AMBER)
d.text((84, 554), "NFL · EuroLeague", font=font(BOLD, 21), fill=AMBER)

bg.convert("RGB").save(os.path.join(ROOT, "docs", "social-preview.png"), optimize=True)
print("wrote docs/social-preview.png")
