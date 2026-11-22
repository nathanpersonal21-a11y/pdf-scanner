from playwright.sync_api import sync_playwright
import os
S=os.path.abspath("test/samples")
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",headless=True,args=["--no-sandbox"])
    ctx=b.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True,accept_downloads=True)
    pg=ctx.new_page(); pg.goto("http://localhost:4173/")
    pg.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller || true")
    pg.evaluate("navigator.serviceWorker.ready.then(()=>true)")
    pg.wait_for_timeout(15000)  # let workbox precache the 13MB engine
    ctx.set_offline(True)
    pg.reload(); pg.wait_for_selector("text=Scan Document", timeout=20000)
    pg.wait_for_function("!document.querySelector('.engine')", timeout=60000)
    pg.set_input_files("input[type=file][multiple]", f"{S}/sample3.png")
    pg.wait_for_selector(".preview img.after", timeout=60000)
    print("OFFLINE OK: app loaded, engine loaded, scanned a page with no network")
    b.close()
