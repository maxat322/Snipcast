"""Repeatable browser capture RAF measurements; CPU throttling is not a weak-PC test."""
import ast, base64, io, json, sys
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
tree=ast.parse((ROOT/'tests/capture_assist.py').read_text(encoding='utf8'))
bridge=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BRIDGE' for t in n.targets))
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for screens in (1,2):
        width=1920*screens; image=Image.new('RGB',(width,1080),(18,52,86));buf=io.BytesIO();image.save(buf,format='PNG')
        for rate in (1,6):
            page=browser.new_page(viewport={'width':width,'height':1080})
            source=bridge.replace('width:1280*scale,height:900*scale',f'width:{width}*scale,height:1080*scale,monitors:[{{x:-1600,y:-200,width:1920,height:1080,scale:1}},'+ ('{x:320,y:-200,width:1920,height:1080,scale:1}' if screens==2 else '')+']')
            page.add_init_script(f'({source})({json.dumps({"png":base64.b64encode(buf.getvalue()).decode(),"scale":1,"theme":"dark"})})')
            cdp=page.context.new_cdp_session(page);cdp.send('Emulation.setCPUThrottlingRate',{'rate':rate})
            page.goto('http://localhost:1420/?snipcast=capture')
            page.wait_for_function("document.querySelector('.capture--presented')")
            timing=page.evaluate('''async()=>{
              const samples=[];let previous=performance.now();
              const root=document.querySelector('.capture');
              root.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:800,clientY:300}));
              for(let i=0;i<120;i++){
                root.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:900+i*3,clientY:400+i}));
                await new Promise(requestAnimationFrame); const now=performance.now();samples.push(now-previous);previous=now;
              }
              root.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,clientX:1260,clientY:520}));
              samples.sort((a,b)=>a-b);
              return {medianMs:samples[60],p95Ms:samples[114],heapBytes:performance.memory?.usedJSHeapSize};
            }''')
            results.append({'screens':screens,'cpuThrottle':rate,**timing});page.close()
    browser.close()
out=ROOT/'.qa-work'/f'capture-perf-{sys.argv[1] if len(sys.argv)>1 else "current"}.json'
out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(results,indent=2),encoding='utf8');print(json.dumps(results))
