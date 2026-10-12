"""Same native capture/open/stroke measurements for before and after binaries."""
import base64,datetime,json,os,shutil,subprocess,sys,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work'/('native-perf-'+sys.argv[1]);OUT.mkdir(parents=True,exist_ok=True)
source=Path(sys.argv[2]);shutil.copy2(source,OUT/'perf-qa.exe')
(OUT/'config.json').write_text(json.dumps({'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'dark','apiEnabled':False,'screenshotPresets':[]}),encoding='utf8')
(OUT/'update-state.json').write_text(json.dumps({'lastAttempt':datetime.date.today().isoformat(),'skippedVersion':None,'dismissedDay':None}),encoding='utf8')
PORT=9257
def invoke(page,cmd,args=None):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args or {}])
def find(ctx,selector):
    for _ in range(150):
        for page in ctx.pages:
            try:
                if page.locator(selector).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError(selector)
log=(OUT/'process.log').open('w',encoding='utf8');proc=subprocess.Popen([str(OUT/'perf-qa.exe')],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'},stdout=log,stderr=log)
try:
    for _ in range(120):
        try:urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.3).close();break
        except OSError:assert proc.poll() is None;time.sleep(.1)
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');ctx=browser.contexts[0];main=find(ctx,'body.settings-body')
        times=[]
        for _ in range(4):
            start=time.perf_counter();invoke(main,'snipcast_start_screenshot');capture=find(ctx,'.capture--presented');times.append(round((time.perf_counter()-start)*1000,1))
            info=invoke(capture,'snipcast_capture_info');invoke(main,'snipcast_close_capture');time.sleep(.2)
        invoke(main,'snipcast_start_screenshot');capture=find(ctx,'.capture--presented');cdp=ctx.new_cdp_session(capture);results=[]
        for rate in (1,6):
            cdp.send('Emulation.setCPUThrottlingRate',{'rate':rate})
            result=capture.evaluate('''async()=>{
              const root=document.querySelector('.capture'),samples=[];
              const event=(type,x,y)=>root.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));
              if(!document.querySelector('.capture__toolbar')){event('pointerdown',100,100);event('pointermove',innerWidth-180,innerHeight-230);event('pointerup',innerWidth-180,innerHeight-230);await new Promise(requestAnimationFrame);}
              document.body.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'4',code:'Digit4'}));await new Promise(requestAnimationFrame);
              event('pointerdown',400,300);let previous=performance.now();
              for(let i=0;i<120;i++) {event('pointermove',400+i*3,300+Math.sin(i*.1)*70);await new Promise(requestAnimationFrame);const now=performance.now();samples.push(now-previous);previous=now;}
              const png=document.querySelector('.capture__shapes--draft').toDataURL();
              event('pointerup',757,300+Math.sin(11.9)*70);document.body.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'z',code:'KeyZ',ctrlKey:true}));
              samples.sort((a,b)=>a-b);return {medianMs:samples[60],p95Ms:samples[114],png};
            }''')
            (OUT/f'live-stroke-cpu-{rate}.png').write_bytes(base64.b64decode(result.pop('png').split(',')[1]))
            results.append({'cpuThrottle':rate,**result})
        cdp.send('Emulation.setCPUThrottlingRate',{'rate':1})
        trajectory=capture.evaluate('''async()=>{
          const root=document.querySelector('.capture');
          const event=(type,p)=>root.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,clientX:p.x,clientY:p.y}));
          const points=Array.from({length:100},(_,i)=>({x:450+70*Math.cos(i/20),y:350+70*Math.sin(i/20)+(i%2?3:-3)}));
          event('pointerdown',points[0]);await new Promise(requestAnimationFrame);
          for(const p of points.slice(1)){event('pointermove',p);await new Promise(requestAnimationFrame);}
          const png=document.querySelector('.capture__shapes--draft').toDataURL();
          event('pointerup',points.at(-1));return {png,points};
        }''')
        (OUT/'irregular-arc.png').write_bytes(base64.b64decode(trajectory.pop('png').split(',')[1]))
        (OUT/'irregular-arc-input.json').write_text(json.dumps(trajectory),encoding='utf8')
        invoke(main,'snipcast_close_capture');result={'source':str(source),'monitors':len(info['monitors']),'openMs':times,'strokeFrames':results}
        (OUT/'results.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))
finally:proc.terminate();proc.wait(timeout=10);log.close()
