"""End-to-end test in real Chrome, iPhone 13 viewport: upload -> detect -> crop -> filter -> add page -> reorder -> PDF."""
import sys, os, json
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173/"
S = os.path.abspath("test/samples")
OUT = os.path.abspath("test/out"); os.makedirs(OUT, exist_ok=True)
errors = []
fails = []
def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name, extra)
    if not ok: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True,
        args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        accept_downloads=True, permissions=["camera"])
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_selector("text=Scan Document")
    page.screenshot(path=f"{OUT}/e2e_01_home.png")
    check("home shows dashboard actions", page.locator("text=Upload Images").count() > 0 and page.locator("text=Recent Scans").count() > 0)
    page.wait_for_function("!document.querySelector('.engine')", timeout=90000)
    check("OpenCV engine loaded in browser", True)

    # 1) upload photo 1
    page.set_input_files("input[type=file][multiple]", f"{S}/sample1.png")
    page.wait_for_selector(".preview img.after", timeout=90000)
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/e2e_02_doc_page1.png")
    check("upload -> page 1 rendered in editor", page.locator("text=Page 1 of 1").count() == 1)

    # 2-3) crop screen shows detected corners; adjust one corner; apply
    page.click("text=Crop")
    page.wait_for_selector(".handle")
    check("crop editor has 4 draggable corners", page.locator(".handle").count() == 4)
    h = page.locator(".handle").first.bounding_box()
    before = (h["x"], h["y"])
    page.mouse.move(h["x"] + h["width"]/2, h["y"] + h["height"]/2)
    page.mouse.down(); page.mouse.move(h["x"] + h["width"]/2 + 6, h["y"] + h["height"]/2 + 6, steps=4)
    page.screenshot(path=f"{OUT}/e2e_03_crop_drag.png")
    check("loupe appears while dragging", page.locator(".loupe").count() == 1)
    page.mouse.up()
    h2 = page.locator(".handle").first.bounding_box()
    check("corner moved by drag", abs(h2["x"] - before[0]) > 3)
    page.click("text=Auto detect")
    page.wait_for_function("document.querySelector('.tool:not([disabled])')", timeout=30000)
    page.wait_for_timeout(1200)
    page.click("text=Done")
    page.wait_for_selector(".preview img.after")
    page.wait_for_timeout(1200)

    # 4) filter
    page.click("role=tab[name='Black & White']")
    page.wait_for_timeout(2500)
    page.screenshot(path=f"{OUT}/e2e_04_bw.png")
    check("B&W filter selected", page.locator("[role=tab][aria-selected=true]").inner_text() == "Black & White")
    # compare slider
    page.click("text=Compare")
    page.wait_for_selector(".cmp .before", timeout=30000)
    page.screenshot(path=f"{OUT}/e2e_05_compare.png")
    check("before/after compare view", page.locator(".cmp .cut").count() == 1)
    page.click("text=Compare")
    page.click("role=tab[name='Document']")
    page.wait_for_timeout(1500)
    # rotate twice (net 180) then back
    page.click("text=Rotate"); page.wait_for_timeout(300); page.click("text=Rotate"); page.click("text=Rotate"); page.click("text=Rotate")
    page.wait_for_timeout(1500)

    # 5) add second page via upload
    page.click("text=Add page")
    page.wait_for_selector("text=Upload images")
    page.click(".sheet >> text=Upload images", no_wait_after=True) if False else None
    with page.expect_file_chooser() as fc:
        page.click(".sheet >> text=Upload images")
    fc.value.set_files(f"{S}/sample2.png")
    page.wait_for_function("document.querySelectorAll('.thumb[data-i]').length === 2", timeout=90000)
    page.wait_for_timeout(2500)
    check("second page added", page.locator("text=Page 2 of 2").count() == 1)
    page.screenshot(path=f"{OUT}/e2e_06_two_pages.png")

    # 6) reorder: move page 2 earlier
    page.click("[aria-label='Move page earlier']")
    page.wait_for_timeout(800)
    check("reorder: moved page now first", page.locator("text=Page 1 of 2").count() == 1)

    # 7) export
    page.click("text=PDF")
    page.wait_for_selector("#pdfname")
    page.fill("#pdfname", "My Test Scan")
    page.click("role=radio[name='A4']")
    page.screenshot(path=f"{OUT}/e2e_07_export.png")
    page.click("text=Create PDF")
    page.wait_for_selector("text=Download PDF", timeout=120000)
    with page.expect_download() as dl:
        page.click("text=Download PDF")
    d = dl.value
    path = f"{OUT}/downloaded.pdf"; d.save_as(path)
    check("downloaded file named from user input", d.suggested_filename == "My Test Scan.pdf", d.suggested_filename)
    page.screenshot(path=f"{OUT}/e2e_08_exported.png")
    page.click("text=Close")

    # recents persisted?
    page.click("[aria-label='Back to home']")
    page.wait_for_selector(".recent-item", timeout=15000)
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/e2e_09_recent.png")
    check("recent scan listed after autosave", page.locator(".recent-item").count() >= 1)

    # camera flow with fake device
    page.click("text=Scan Document")
    page.wait_for_selector(".shutter:not([disabled])", timeout=20000)
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/e2e_10_camera.png")
    page.click(".shutter")
    page.wait_for_selector(".round.done b", timeout=60000)
    check("webcam capture adds a page", page.locator(".round.done b").inner_text() == "1")
    page.click(".round.done")
    page.wait_for_selector("text=Page 1 of 1", timeout=30000)
    check("camera done -> editor", True)
    ctx.close(); b.close()

print("console/page errors:", [e for e in errors if "favicon" not in e][:5])
res = [e for e in errors if "favicon" not in e]
if res: fails.append("browser errors")
print("FAILED:" , fails if fails else "none")
sys.exit(1 if fails else 0)
