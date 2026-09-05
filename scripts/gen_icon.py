from PIL import Image, ImageDraw

SIZE = 1024
BG = (20, 22, 26, 255)       # matches shell header (#14161a)
ACCENT = (29, 99, 255, 255)  # matches focused-pane accent (#1d63ff)
SEAM = (20, 22, 26, 255)

def rounded_square(size, radius, fill):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=fill)
    return img

def draw_basketball(img, cx, cy, r):
    d = ImageDraw.Draw(img)
    bbox = [cx - r, cy - r, cx + r, cy + r]
    d.ellipse(bbox, fill=ACCENT)
    w = max(6, r // 22)
    d.line([cx, cy - r, cx, cy + r], fill=SEAM, width=w)
    d.line([cx - r, cy, cx + r, cy], fill=SEAM, width=w)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=200, end=340, fill=SEAM, width=w)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=20, end=160, fill=SEAM, width=w)
    d.ellipse(bbox, outline=SEAM, width=w)

img = rounded_square(SIZE, radius=int(SIZE * 0.22), fill=BG)
draw_basketball(img, SIZE // 2, SIZE // 2, int(SIZE * 0.32))
img.save("icon_1024.png")
