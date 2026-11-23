"""Readable-text E2E on hard photos: angle + hard shadow + glare -> Readable text -> PDF; verify real text in the PDF."""
import os, re, subprocess, sys
from playwright.sync_api import sync_playwright
BASE="http://localhost:4173/"; S=os.path.abspath("test/samples"); OUT=os.path.abspath("test/out")
VOCAB=set("the quick brown fox jumps over a lazy dog while scanning this important contract page".split())
fails=[]; errors=[]
def check(n,ok,x=""):
    print(("PASS " if ok else "FAIL ")+n,x)
    if not ok: fails.append(n)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",headless=True,args=["--no-sandbox"])
    ctx=b.new_context(viewport={"width":390,"height":844},device_scale_factor=3,is_mobile=True,has_touch=True,accept_downloads=True,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    pg=ctx.new_page(); pg.on("pageerror",lambda e:errors.append(str(e))); pg.on("console",lambda m: errors.append(m.text) if m.type=="error" else None)
    pg.goto(BASE); pg.wait_for_selector("text=Scan Document"); pg.wait_for_function("!document.querySelector('.engine')",timeout=90000)
    pg.set_input_files("input[type=file][multiple]",[f"{S}/hard1.png",f"{S}/hard2.png"])
    pg.wait_for_function("document.querySelectorAll('.thumb[data-i]').length===2",timeout=120000)
    pg.wait_for_timeout(2500); pg.screenshot(path=f"{OUT}/e3_01_cleaned.png")
    check("2 angled photos loaded", pg.locator("text=Page 1 of 2").count()==1)
    # shape control present in crop editor
    pg.click("text=Crop"); pg.wait_for_selector(".shape-row")
    check("page-shape control in crop editor", pg.locator(".shape-row [role=radio]").count()==4)
    pg.click("role=radio[name='Letter']"); pg.click("text=Done"); pg.wait_for_selector(".preview img.after"); pg.wait_for_timeout(1500)
    # readable toggle
    pg.check("text=Readable text >> xpath=../input") if False else pg.locator("label.switch:has-text('Readable text') input").check(force=True)
    pg.wait_for_selector("[data-testid=readable-preview] img",timeout=240000)
    pg.wait_for_timeout(1500); pg.screenshot(path=f"{OUT}/e3_02_readable.png")
    check("readable preview shown", pg.locator("[data-testid=readable-preview] img").count()>=1)
    pg.click(".thumb[data-i='1']"); pg.wait_for_selector("[data-testid=readable-preview] img",timeout=60000); pg.wait_for_timeout(1200)
    pg.screenshot(path=f"{OUT}/e3_03_readable_p2.png")
    # export
    pg.click("text=PDF"); pg.wait_for_selector("#pdfname"); pg.fill("#pdfname","Readable Test")
    check("export sheet explains readable mode", pg.locator("text=Readable text is on").count()==1)
    pg.click("text=Create PDF"); pg.wait_for_selector("text=Download PDF",timeout=240000)
    with pg.expect_download() as dl: pg.click("text=Download PDF")
    path=f"{OUT}/readable.pdf"; dl.value.save_as(path)
    pg.screenshot(path=f"{OUT}/e3_04_export.png")
    check("downloaded name", dl.value.suggested_filename=="Readable Test.pdf")
    # toggle off restores image preview
    pg.click("text=Close"); pg.locator("label.switch:has-text('Readable text') input").uncheck(force=True)
    pg.wait_for_selector(".preview img.after",timeout=30000)
    check("toggle off returns to scan preview", pg.locator("[data-testid=readable-preview]").count()==0)
    b.close()
txt=subprocess.run(["pdftotext","-layout",path,"-"],capture_output=True,text=True).stdout
info=subprocess.run(["pdfinfo",path],capture_output=True,text=True).stdout
print(info); print("--- extracted text (first 25 lines) ---"); print("\n".join(txt.splitlines()[:25]))
toks=[t for t in re.findall(r"[a-z]+",txt.lower())]
ok=[t for t in toks if t in VOCAB or t in {"quarterly","report","lease","agreement"}]
acc=len(ok)/max(1,len(toks)); print("tokens",len(toks),"in-vocabulary",round(acc,3))
check("PDF has selectable text", len(toks)>80)
check("OCR word accuracy >= 85%", acc>=0.85, f"{acc:.1%}")
check("titles recovered", "QUARTERLY REPORT" in txt.upper() and "LEASE AGREEMENT" in txt.upper())
fonts=subprocess.run(["pdffonts",path],capture_output=True,text=True).stdout; print(fonts)
sizes=set(re.findall(r"",""))
print("console errors:",[e for e in errors if 'favicon' not in e][:5])
if [e for e in errors if 'favicon' not in e]: fails.append("browser errors")
print("FAILED:",fails or "none"); sys.exit(1 if fails else 0)
