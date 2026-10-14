"""Native PNG identity and JPEG color error on a gradient and a bundled photograph."""
import base64,io,json,os,shutil,subprocess,time,urllib.request
from pathlib import Path
import numpy as np,psutil
from PIL import Image,ImageChops
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work'/'color-0366-native';OUT.mkdir(parents=True,exist_ok=True);PORT=9281
shutil.copy2(Path(os.environ['SNIPCAST_QA_EXE']),OUT/'color-qa.exe')
(OUT/'config.json').write_text(json.dumps({'paletteHotkey':'','screenshotHotkey':'','autostart':False,'screenshotPresets':[],'screenshotPresetDefaultsVersion':1}),encoding='utf-8')
(OUT/'update-state.json').write_text(json.dumps({'lastAttempt':time.strftime('%Y-%m-%d')}),encoding='utf-8')
proc=subprocess.Popen([str(OUT/'color-qa.exe')],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'+(' --force-color-profile=srgb' if os.environ.get('SNIPCAST_QA_FORCE_SRGB') else '')})
results=[]
try:
  for _ in range(120):
    try:urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.2).close();break
    except OSError:time.sleep(.1)
  with sync_playwright() as p:
    browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');context=browser.contexts[0]
    for _ in range(120):
      page=next((view for view in context.pages if view.locator('body.settings-body').count()),None)
      if page:break
      time.sleep(.05)
    assert page
    gradient=Image.fromarray(np.stack([*np.meshgrid(np.arange(640,dtype=np.uint16)%256,np.arange(360,dtype=np.uint16)%256)[::-1],np.full((360,640),80,dtype=np.uint16)],axis=-1).astype('uint8'))
    cases=[('gradient',gradient)]
    photo=Path('C:/Windows/Web/Wallpaper/Windows/img0.jpg')
    if photo.is_file():cases.append(('bundled-photo',Image.open(photo).convert('RGB').resize((640,360))))
    for name,source in cases:
      data=io.BytesIO();source.save(data,format='PNG');png=base64.b64encode(data.getvalue()).decode()
      for format in ['png','jpeg']:
        path=OUT/(name+'.'+format)
        page.evaluate('args=>window.__TAURI_INTERNALS__.invoke("snipcast_capture_save",args)',{'png':png,'path':str(path),'format':format,'quality':90})
        actual=Image.open(path).convert('RGB');mae=float(np.abs(np.asarray(actual,dtype=np.int16)-np.asarray(source,dtype=np.int16)).mean())
        if format=='png':assert ImageChops.difference(actual,source).getbbox() is None
        else:assert mae<5,(name,mae)
        results.append({'image':name,'format':format,'meanAbsoluteColorError':mae,'bytes':path.stat().st_size})
      page.evaluate('args=>window.__TAURI_INTERNALS__.invoke("snipcast_capture_pin",args)',{'png':png,'x':100,'y':100,'width':640,'height':360})
      for _ in range(120):
        pin=next((view for view in context.pages if view.locator('.pin__shot').count()),None)
        if pin:break
        time.sleep(.05)
      assert pin
      pin.wait_for_function('document.querySelector(".pin__shot")?.complete')
      decoded=pin.evaluate('()=>{const img=document.querySelector(".pin__shot");const c=document.createElement("canvas");c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext("2d").drawImage(img,0,0);return c.toDataURL("image/png").split(",")[1];}')
      assert ImageChops.difference(Image.open(io.BytesIO(base64.b64decode(decoded))).convert('RGB'),source).getbbox() is None
      rendered=Image.open(io.BytesIO(pin.locator('.pin__shot').screenshot())).convert('RGB')
      rendered.save(OUT/(name+'-pin.png'))
      difference=ImageChops.difference(rendered,source)
      assert rendered.size==source.size and difference.getbbox() is None,('Pinned display pixels differ',name,rendered.size,difference.getbbox(),float(np.abs(np.asarray(rendered,dtype=np.int16)-np.asarray(source,dtype=np.int16)).mean()),[rendered.getpixel(pt) for pt in [(0,0),(100,100),(320,180)]],[source.getpixel(pt) for pt in [(0,0),(100,100),(320,180)]])
      results.append({'image':name,'format':'pin-preview','pixelsExact':True})
      page.evaluate('()=>window.__TAURI_INTERNALS__.invoke("snipcast_close_all_pins")')
    browser.close()
finally:
  children=psutil.Process(proc.pid).children(recursive=True) if proc.poll() is None else []
  if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
  for child in children:
    try:child.terminate()
    except psutil.NoSuchProcess:pass
  psutil.wait_procs(children,timeout=3)
(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results))
