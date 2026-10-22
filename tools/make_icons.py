"""Generate PNG icons (dev-time only; the app ships the resulting PNGs).
Usage: python3 tools/make_icons.py   (needs Pillow)"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
BG, PAGE, FOLD, LINE, SCAN = '#1d4ed8', '#ffffff', '#cbd5e1', '#94a3b8', '#22d3ee'

def draw(size, maskable):
    S = size * 4
    img = Image.new('RGBA', (S, S), BG if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if not maskable:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)
    k = 0.60 if maskable else 0.68                      # maskable keeps content in the safe zone
    pw, ph = S * k * 0.74, S * k
    x0, y0 = (S - pw) / 2, (S - ph) / 2
    fold = pw * 0.26
    d.polygon([(x0, y0), (x0 + pw - fold, y0), (x0 + pw, y0 + fold), (x0 + pw, y0 + ph), (x0, y0 + ph)], fill=PAGE)
    d.polygon([(x0 + pw - fold, y0), (x0 + pw, y0 + fold), (x0 + pw - fold, y0 + fold)], fill=FOLD)
    for i in range(4):
        y = y0 + ph * (0.40 + i * 0.12)
        d.rounded_rectangle([x0 + pw * 0.14, y, x0 + pw * (0.86 if i < 3 else 0.55), y + ph * 0.035], radius=ph * 0.017, fill=LINE)
    sy = y0 + ph * 0.28
    d.rounded_rectangle([x0 - pw * 0.12, sy, x0 + pw * 1.12, sy + ph * 0.045], radius=ph * 0.022, fill=SCAN)
    return img.resize((size, size), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
for name, size, mask in [('icon-192.png', 192, False), ('icon-512.png', 512, False),
                         ('icon-maskable-512.png', 512, True), ('favicon-32.png', 32, False)]:
    draw(size, mask).save(os.path.join(OUT, name), optimize=True)
# iOS ignores transparency; give it a solid full-bleed square (iOS rounds the corners itself).
ios = draw(180, True).convert('RGB')
ios.save(os.path.join(OUT, 'apple-touch-icon.png'), optimize=True)
print('icons written to', os.path.abspath(OUT))
