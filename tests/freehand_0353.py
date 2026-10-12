"""Trajectory shape, event-density invariance and live/export identity."""
from pathlib import Path
import math
exec((Path(__file__).parent/'capture_035.py').read_text(encoding='utf8').split('with sync_playwright() as p:')[0])
OUT=ROOT/'.qa-work'/'freehand-0353';OUT.mkdir(parents=True,exist_ok=True)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);results=[]
    page,errors=fixture(browser)
    checks=page.evaluate('''async()=>{
      const {freehandGeometry,drawShape,hitTest,shapeBounds}=await import('/src/capture/shapes.ts');
      const jitter=Array.from({length:151},(_,i)=>({x:100+i*2,y:200+(i===0||i===150?0:(i%2?6:-6))}));
      const corners=[{x:100,y:100},{x:280,y:100},{x:280,y:280}];
      const dense=Array.from({length:91},(_,i)=>({x:100+i*2,y:100})).concat(Array.from({length:90},(_,i)=>({x:280,y:102+i*2})));
      const curve=freehandGeometry(corners),repeated=freehandGeometry(dense.flatMap(p=>[p,p,p]));
      const maxDelta=Math.max(...curve.hitPoints.map((p,i)=>Math.hypot(p.x-repeated.hitPoints[i].x,p.y-repeated.hitPoints[i].y)));
      const points=freehandGeometry(jitter).hitPoints;
      const amplitude=Math.max(...points.filter(p=>p.x>130&&p.x<370).map(p=>Math.abs(p.y-200)));
      const cornerInset=Math.min(...curve.hitPoints.map(p=>Math.hypot(p.x-280,p.y-100)));
      const turns=curve.hitPoints.slice(1,-1).map((p,i)=>{const a=curve.hitPoints[i],b=curve.hitPoints[i+2];
        const u={x:p.x-a.x,y:p.y-a.y},v={x:b.x-p.x,y:b.y-p.y};
        return Math.acos(Math.max(-1,Math.min(1,(u.x*v.x+u.y*v.y)/(Math.hypot(u.x,u.y)*Math.hypot(v.x,v.y)))))*180/Math.PI;});
      const shifted=freehandGeometry([{x:100,y:300},{x:300,y:300},{x:320,y:330},{x:350,y:300}],1);
      const shape={id:1,kind:'freehand',p1:corners[0],p2:corners.at(-1),points:corners,color:'#ff4545',thickness:4};
      const bounds=shapeBounds(shape),top=curve.hitPoints[0],last=curve.hitPoints.at(-1);
      const canvas=document.createElement('canvas');canvas.width=500;canvas.height=400;const ctx=canvas.getContext('2d');
      drawShape(ctx,shape,1);drawShape(ctx,{...shape,points:jitter,p1:jitter[0],p2:jitter.at(-1)},1);
      return {maxDelta,amplitude,cornerInset,maxTurn:Math.max(...turns),top,last,bounds,prefix:shifted.hitPoints.slice(0,2),
        hit:hitTest(shape,curve.hitPoints[Math.floor(curve.hitPoints.length/2)]),
        endpoints:ctx.getImageData(100,100,1,1).data[3]>0&&ctx.getImageData(280,280,1,1).data[3]>0,
        short:freehandGeometry([{x:1,y:1},{x:2,y:2}]).hitPoints.at(-1),
        dot:freehandGeometry([{x:1,y:1},{x:1,y:1}]).hitPoints,
        rawUnchanged:JSON.stringify(corners)==='[{"x":100,"y":100},{"x":280,"y":100},{"x":280,"y":280}]',
        png:canvas.toDataURL()};
    }''')
    Image.open(io.BytesIO(base64.b64decode(checks.pop('png').split(',')[1]))).save(OUT/'trajectory.png')
    assert checks['maxDelta']<1e-6,checks
    assert checks['amplitude']<1.5,checks # raw excursion is 6px on either side
    assert checks['cornerInset']>3 and checks['maxTurn']<30,checks # no 90-degree joint remains
    assert checks['top']=={'x':100,'y':100} and checks['last']=={'x':280,'y':280},checks
    assert checks['prefix']==[{'x':100,'y':300},{'x':300,'y':300}],checks
    assert checks['short']=={'x':2,'y':2} and len(checks['dot'])==1,checks
    assert checks['hit'] and checks['endpoints'] and checks['rawUnchanged'],checks
    assert not errors,errors;results.append(checks);page.close()
    # Actual events, not only calls to the mathematical helper. Check the
    # displayed stroke before release against the exported, committed PNG.
    for scale in (1,1.5,2):
        page,errors=fixture(browser,scale);drag(page,(100,100),(600,600));page.keyboard.press('4')
        points=[(round(310+80*math.cos(i/24)),round(310+80*math.sin(i/24)+(4 if i%2 else -4))) for i in range(120)]
        page.mouse.move(*points[0]);page.mouse.down()
        for point in points[1:]:page.mouse.move(*point);page.wait_for_timeout(4)
        page.wait_for_timeout(40)
        draft=page.locator('.capture__shapes--draft').evaluate('el=>el.toDataURL()')
        page.screenshot(path=str(OUT/f'live-{scale}.png'));page.mouse.up();page.wait_for_timeout(40)
        page.keyboard.press('c');page.wait_for_function('qa.pngs.length===1')
        preview=Image.open(io.BytesIO(base64.b64decode(draft.split(',')[1]))).convert('RGBA')
        composited=Image.new('RGBA',preview.size,(18,52,86,255));composited.alpha_composite(preview)
        before=composited.convert('RGB').crop(tuple(round(x*scale) for x in (200,200,420,420)))
        after=decode(page).crop(tuple(round(x*scale) for x in (100,100,320,320)))
        delta=max(abs(a-b) for pa,pb in zip(before.get_flattened_data(),after.get_flattened_data()) for a,b in zip(pa,pb))
        assert delta<=3,('stroke changed on release/export',scale,delta)
        decode(page).save(OUT/f'export-{scale}.png')
        page.keyboard.press('Control+z');page.keyboard.press('c');page.wait_for_function('qa.pngs.length===2')
        assert set(decode(page).get_flattened_data())=={(18,52,86)}
        page.keyboard.press('Control+Shift+z');page.keyboard.press('c');page.wait_for_function('qa.pngs.length===3')
        assert not errors,errors;results.append({'scale':scale,'liveExportDelta':delta});page.close()
    browser.close();(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print(json.dumps(results))
