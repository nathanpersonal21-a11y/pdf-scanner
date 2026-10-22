"""Create a synthetic 'photo of a page on a desk' used as the fake camera feed and as an import."""
import sys, os, random
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
W, H = 1280, 960
random.seed(3)

def page_image(title):
    pw, ph = 850, 1100
    img = Image.new('RGB', (pw, ph), (240, 236, 226))
    d = ImageDraw.Draw(img)
    try: f = ImageFont.load_default(size=44); f2 = ImageFont.load_default(size=26)
    except TypeError: f = f2 = ImageFont.load_default()
    d.text((60, 70), title, fill=(20, 20, 30), font=f)
    y = 180
    for i in range(24):
        d.text((60, y), "The quick brown fox jumps over the lazy dog %d" % (i * 7), fill=(30, 30, 40), font=f2)
        y += 38
    return img

def photo(title, quad):
    desk = Image.new('RGB', (W, H), (70, 52, 40))
    page = page_image(title)
    pw, ph = page.size
    # perspective coeffs mapping output(quad) -> source(page)
    import numpy as np
    src = [(0, 0), (pw, 0), (pw, ph), (0, ph)]
    A = []; B = []
    for (x, y), (u, v) in zip(quad, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    coeffs = np.linalg.solve(np.array(A, float), np.array(B, float))
    warped = page.transform((W, H), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC, fillcolor=(0, 0, 0))
    mask = Image.new('L', (pw, ph), 255).transform((W, H), Image.PERSPECTIVE, tuple(coeffs), Image.BILINEAR, fillcolor=0)
    desk.paste(warped, (0, 0), mask)
    return desk

q = [(300, 130), (980, 190), (940, 840), (240, 790)]
p = photo("INVOICE 2026-10", q)
p.save(os.path.join(out, 'doc1.jpg'), quality=92)
photo("MEETING NOTES", [(220, 110), (1010, 140), (990, 860), (260, 830)]).save(os.path.join(out, 'doc2.jpg'), quality=92)
# camera feed: Chrome's fake device accepts a motion-JPEG file
with open(os.path.join(out, 'doc1.jpg'), 'rb') as fh: data = fh.read()
# fake capture wants constant frame size; reuse same jpeg for every frame
with open(os.path.join(out, 'feed.mjpeg'), 'wb') as fh:
    for _ in range(30): fh.write(data)
print('truth quad (px of 1280x960):', q)
