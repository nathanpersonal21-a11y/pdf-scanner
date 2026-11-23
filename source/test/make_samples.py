"""Generates synthetic 'photos' of documents for testing: perspective, shadow, desk, finger."""
import numpy as np, sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(7)

def make_page(title, w=850, h=1100, seed=0):
    r = np.random.default_rng(seed)
    pg = Image.new("RGB", (w, h), (246, 245, 240))
    d = ImageDraw.Draw(pg)
    f1 = ImageFont.load_default(size=44)
    f2 = ImageFont.load_default(size=22)
    d.text((70, 80), title, fill=(20, 20, 30), font=f1)
    y = 170
    words = "the quick brown fox jumps over a lazy dog while scanning this important contract page".split()
    while y < h - 120:
        line = " ".join(r.choice(words, size=int(r.integers(6, 11))))
        d.text((70, y), line, fill=(30, 30, 35), font=f2)
        y += 38
    d.rectangle([70, h - 110, w - 70, h - 108], fill=(40, 40, 40))
    return pg

def find_coeffs(pa, pb):
    # PIL perspective: maps output (pa) -> input (pb)
    A = []
    for p1, p2 in zip(pa, pb):
        A.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0]*p1[0], -p2[0]*p1[1]])
        A.append([0, 0, 0, p1[0], p1[1], 1, -p2[1]*p1[0], -p2[1]*p1[1]])
    A = np.array(A, dtype=float); B = np.array(pb, dtype=float).reshape(8)
    return np.linalg.solve(A, B)

def photo(page, quad, desk, finger=None, shadow=True, size=(1600, 1200)):
    W, H = size
    bg = np.zeros((H, W, 3), np.float32)
    bg[:] = desk
    bg += rng.normal(0, 6, bg.shape)
    # wood-ish grain
    bg += (np.sin(np.arange(H)[:, None] * 0.35) * 5)[:, :, None]
    canvas = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8))
    pw, ph = page.size
    coeffs = find_coeffs(quad, [(0, 0), (pw, 0), (pw, ph), (0, ph)])
    warped = page.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    mask = Image.new("L", page.size, 255).transform((W, H), Image.PERSPECTIVE, coeffs, Image.BILINEAR)
    arr = np.asarray(warped).astype(np.float32)
    if shadow:
        gx = np.linspace(1.0, 0.72, W)[None, :, None]
        gy = np.linspace(1.0, 0.9, H)[:, None, None]
        arr = arr * gx * gy
    m = (np.asarray(mask).astype(np.float32) / 255.0)[:, :, None]
    comp = np.asarray(canvas).astype(np.float32) * (1 - m) + arr * m
    img = Image.fromarray(np.clip(comp, 0, 255).astype(np.uint8))
    if finger:
        d = ImageDraw.Draw(img)
        for (x0, y0, x1, y1) in finger:
            d.rounded_rectangle([x0, y0, x1, y1], radius=(x1 - x0) // 2, fill=(228, 176, 142))
        img = img.filter(ImageFilter.GaussianBlur(0.8))
    return img.filter(ImageFilter.GaussianBlur(0.6))


def project(yaw, pitch, roll, tx, ty, tz, f=1400.0, cx=800.0, cy=600.0, pw=850, ph=1100):
    """Pinhole camera looking at a flat page. Returns the 4 projected corners TL,TR,BR,BL."""
    import math
    sc = 0.001  # px -> metres-ish
    pts = np.array([[-pw/2, -ph/2, 0], [pw/2, -ph/2, 0], [pw/2, ph/2, 0], [-pw/2, ph/2, 0]], float) * sc
    ya, pi, ro = map(math.radians, (yaw, pitch, roll))
    Ry = np.array([[math.cos(ya), 0, math.sin(ya)], [0, 1, 0], [-math.sin(ya), 0, math.cos(ya)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(pi), -math.sin(pi)], [0, math.sin(pi), math.cos(pi)]])
    Rz = np.array([[math.cos(ro), -math.sin(ro), 0], [math.sin(ro), math.cos(ro), 0], [0, 0, 1]])
    R = Rz @ Rx @ Ry
    out = []
    for q in pts:
        c = R @ q + np.array([tx, ty, tz])
        out.append((f * c[0] / c[2] + cx, f * c[1] / c[2] + cy))
    return out

quad1 = project(14, 28, 4, 0.03, 0.02, 1.85)
img1 = photo(make_page("INVOICE 1042", seed=1), quad1, desk=(92, 62, 42),
             finger=[(int(quad1[3][0])-35, int(quad1[3][1])-60, int(quad1[3][0])+60, 1215), (int(quad1[3][0])+60, int(quad1[3][1])-5, int(quad1[3][0])+150, 1215)])
img1.save(f"{out}/sample1.png")

quad2 = project(-18, 22, -8, 0.0, 0.0, 1.9)
img2 = photo(make_page("MEETING NOTES", seed=2), quad2, desk=(70, 78, 90), shadow=False)
img2.save(f"{out}/sample2.png")

quad3 = project(8, 35, 12, -0.02, 0.0, 2.0)
img3 = photo(make_page("RECEIPT 0007", seed=3), quad3, desk=(40, 40, 44))
img3.save(f"{out}/sample3.png")

# ground-truth quads (normalised) for the test
import json
W, H = 1600, 1200
gt = {n: [[x / W, y / H] for x, y in q] for n, q in [("sample1", quad1), ("sample2", quad2), ("sample3", quad3)]}
json.dump(gt, open(f"{out}/truth.json", "w"))
print("samples written")


# ---------- hard cases: steep angle, hard shadow edge, specular glare ----------
def photo_hard(page, quad, desk, glare=None, hard_shadow=None, size=(1600, 1200)):
    img = photo(page, quad, desk, shadow=False, size=size)
    arr = np.asarray(img).astype(np.float32)
    H, W = arr.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W]
    # page mask to confine effects to the paper
    pw, ph = page.size
    coeffs = find_coeffs(quad, [(0, 0), (pw, 0), (pw, ph), (0, ph)])
    m = np.asarray(Image.new("L", page.size, 255).transform((W, H), Image.PERSPECTIVE, coeffs, Image.BILINEAR)).astype(np.float32) / 255
    if hard_shadow:
        (x0, y0), (x1, y1), dark = hard_shadow  # a line; one side darker, soft 6px edge
        d = ((xx - x0) * (y1 - y0) - (yy - y0) * (x1 - x0)) / np.hypot(x1 - x0, y1 - y0)
        f = 1 - (1 - dark) / (1 + np.exp(d / 5.0))
        arr = arr * (1 - m[:, :, None] + m[:, :, None] * f[:, :, None])
    if glare:
        gx, gy, gr = glare
        g = np.exp(-(((xx - gx) / gr) ** 2 + ((yy - gy) / (gr * 0.7)) ** 2))
        arr = arr + (255 - arr) * (0.95 * g * m)[:, :, None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.5))

pg = make_page("QUARTERLY REPORT", seed=11)
q4 = project(10, 52, 6, 0.0, 0.0, 1.5)      # steep pitch: strong perspective
img4 = photo_hard(pg, q4, (80, 60, 45), hard_shadow=((600, 200), (900, 1100), 0.55))
img4.save(f"{out}/hard1.png")
q5 = project(-24, 44, -10, 0.0, 0.0, 1.6)
img5 = photo_hard(make_page("LEASE AGREEMENT", seed=12), q5, (60, 70, 80), glare=(850, 520, 110), hard_shadow=((300, 100), (500, 1100), 0.65))
img5.save(f"{out}/hard2.png")
q6 = project(28, 40, 3, 0.0, 0.0, 1.55)
img6 = photo_hard(make_page("CLASS NOTES", seed=13), q6, (110, 100, 90), glare=(700, 600, 140))
img6.save(f"{out}/hard3.png")
gt2 = {n: [[x / W, y / H] for x, y in q] for n, q in [("hard1", q4), ("hard2", q5), ("hard3", q6)]}
gt.update(gt2)
json.dump(gt, open(f"{out}/truth.json", "w"))
# keep the clean source pages for a pixel-level warp check
make_page("QUARTERLY REPORT", seed=11).save(f"{out}/hard1_page.png")
make_page("LEASE AGREEMENT", seed=12).save(f"{out}/hard2_page.png")
make_page("CLASS NOTES", seed=13).save(f"{out}/hard3_page.png")
print("hard samples written")
