import {useCallback,useEffect,useRef,useState,type ReactNode,type PointerEvent as ReactPointerEvent} from "react";
import {convertFileSrc,invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {save} from "@tauri-apps/plugin-dialog";
import type {AppConfig} from "../types";
import {ThemedSelect} from "../components/ThemedSelect";
import {applyUiThemeSetting,normalizeUiTheme} from "../uiTheme";
import "./video.css";

type Status={id:number;phase:string;durationMs:number;bytes:number;width:number;height:number;fps:number;audio:boolean;hardware:boolean;frames:number;exportPercent:number;error:string};
type Crop={x:number;y:number;w:number;h:number};
const native="__TAURI_INTERNALS__" in window;
const clock=(seconds:number)=>{const n=Math.max(0,seconds);return `${Math.floor(n/60).toString().padStart(2,"0")}:${Math.floor(n%60).toString().padStart(2,"0")},${Math.floor(n*10+0.001)%10}`;};
const size=(bytes:number)=>`${(bytes/1048576).toFixed(1).replace(".",",")} МБ`;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const TRIM_HANDLE_WIDTH=16;
export function VideoIcon({name}:{name:"play"|"pause"|"stop"|"close"|"crop"|"save"|"video"|"sound"}) {
  const paths:Record<typeof name,ReactNode>={
    play:<path d="m8 5 11 7-11 7Z"/>,pause:<><path d="M8 5v14M16 5v14"/></>,stop:<rect x="6" y="6" width="12" height="12" rx="1"/>,
    close:<path d="m6 6 12 12M18 6 6 18"/>,crop:<><path d="M6 3v15h15M3 6h15v15"/></>,
    save:<><path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/></>,
    video:<><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></>,
    sound:<><path d="m11 4-5 4H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]}</svg>;
}
function useVideoStatus(){
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(""),[config,setConfig]=useState<AppConfig|null>(null);
  useEffect(()=>{if(!native)return;let alive=true;let off:(()=>void)|undefined;
    void(async()=>{try{off=await listen<Status>("snipcast://video-status",event=>{if(alive)setStatus(event.payload);});
      const st=await invoke<Status>("snipcast_video_status");if(!alive)return;setStatus(st);
      const cfg=await invoke<AppConfig>("snipcast_get_config");if(!alive)return;setConfig(cfg);applyUiThemeSetting(normalizeUiTheme(cfg.theme));
      await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));if(alive)await invoke("snipcast_video_ready");
    }catch(e){if(alive)setError(String(e));}})();
    return()=>{alive=false;off?.();};},[]);
  return {status,error,setError,config};
}
export function RecordControl(){
  const {status,error,setError}=useVideoStatus();const phase=status?.phase;
  const run=async(command:string,args?:Record<string,unknown>)=>{try{setError("");await invoke(command,args);}catch(e){setError(String(e));}};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==="Escape"&&["recording","paused"].includes(phase??"")){e.preventDefault();void run("snipcast_video_stop");}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[phase]);
  return <div className="video-record" data-phase={phase}>
    <div className="video-record__clock" data-tauri-drag-region><i/><strong>{clock((status?.durationMs??0)/1000).split(",")[0]}</strong><span>{phase==="paused"?"Пауза":phase==="stopping"?"Завершение…":phase==="starting"?"Подготовка…":phase==="error"?"Ошибка":"Запись"}</span></div>
    <button className="video-tool" aria-label={phase==="paused"?"Продолжить":"Пауза"} title="Пауза / продолжить (F11)" disabled={!status||!["recording","paused"].includes(phase??"")} onClick={()=>void run("snipcast_video_pause",{paused:phase!=="paused"})}><VideoIcon name={phase==="paused"?"play":"pause"}/><kbd>F11</kbd></button>
    <button className="video-tool" aria-label="Завершить" title="Завершить запись (F12)" disabled={!status||!["starting","recording","paused"].includes(phase??"")} onClick={()=>void run("snipcast_video_stop")}><VideoIcon name="stop"/><kbd>F12</kbd></button>
    {phase==="error"?<button className="video-icon-button" aria-label="Закрыть" onClick={()=>void getCurrentWindow().close()}><VideoIcon name="close"/></button>:null}
    {(error||status?.error)?<div className="video-record__error" role="alert">{error||status?.error}</div>:null}
  </div>;
}

export function VideoEditor(){
  const {status,error,setError,config}=useVideoStatus();const video=useRef<HTMLVideoElement>(null),preview=useRef<HTMLDivElement>(null);
  const [start,setStart]=useState(0),[end,setEnd]=useState(0),[position,setPosition]=useState(0),[playing,setPlaying]=useState(false);
  const [format,setFormat]=useState("mp4"),[quality,setQuality]=useState("small"),[gifWidth,setGifWidth]=useState(800),[gifFps,setGifFps]=useState(10);
  const [cropOn,setCropOn]=useState(false),[crop,setCrop]=useState<Crop>({x:0,y:0,w:1,h:1});
  const [appliedCrop,setAppliedCrop]=useState<Crop|null>(null);
  const [thumbnails,setThumbnails]=useState<string[]>([]);
  const [quickOpen,setQuickOpen]=useState(false),[hoverQuick,setHoverQuick]=useState<number|null>(null);
  const hold=useRef<{timer:number;fired:boolean}|null>(null),suppressClick=useRef(false),saveAction=useRef<(loc?:{name:string;path:string})=>Promise<void>>(async()=>{});
  const [view,setView]=useState({w:640,h:360}),[dialogBusy,setDialogBusy]=useState(false);
  const initialized=useRef<number|null>(null),drag=useRef<{x:number;y:number;original:Crop;handle:string}|null>(null),scrub=useRef<number|null>(null),boundaryPreview=useRef(false);
  const duration=(status?.durationMs??0)/1000,selected=Math.max(0,end-start),busy=status?.phase==="exporting"||dialogBusy;
  const ready=status?.phase==="editing";
  const source=status?convertFileSrc(`${status.id}.mp4`,"snipcast-video"):"";
  const sourceWidth=status?.width??960,sourceHeight=status?.height??540;
  const even=(value:number)=>Math.floor((value+1e-6)/2)*2;
  const cropPixels=(c:Crop|null)=>({x:c?even(c.x*sourceWidth):0,y:c?even(c.y*sourceHeight):0,
    width:c?Math.max(16,even(c.w*sourceWidth)):sourceWidth,height:c?Math.max(16,even(c.h*sourceHeight)):sourceHeight});
  const pixels=cropPixels(appliedCrop),draftPixels=cropPixels(crop);
  const visibleCrop=cropOn?null:appliedCrop,visibleWidth=visibleCrop?pixels.width:sourceWidth,visibleHeight=visibleCrop?pixels.height:sourceHeight;
  const bpp=quality==="small"?.04:quality==="sharp"?.16:.08;
  const kbps=clamp(Math.round(pixels.width*pixels.height*(status?.fps??30)*bpp/1000),300,20000);
  const estimate=(kbps+(status?.audio?96:0))*1000*selected/8;
  useEffect(()=>{if(status&&initialized.current!==status.id){initialized.current=status.id;setEnd(status.durationMs/1000);}},[status]);
  useEffect(()=>{const container=preview.current;if(!container)return;const observer=new ResizeObserver(([entry])=>{
    const scale=Math.min(entry.contentRect.width/visibleWidth,entry.contentRect.height/visibleHeight);
    setView({w:visibleWidth*scale,h:visibleHeight*scale});});observer.observe(container);return()=>observer.disconnect();},[visibleWidth,visibleHeight]);
  useEffect(()=>{if(!source||!duration)return;let cancelled=false;
    const decoder=document.createElement("video");decoder.crossOrigin="anonymous";decoder.muted=true;decoder.preload="auto";decoder.src=source;
    const canvas=document.createElement("canvas");canvas.width=144;canvas.height=Math.round(144*sourceHeight/sourceWidth);
    const frames:string[]=[];
    const wait=(name:string)=>new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{cleanup();reject(new Error("thumbnail timeout"));},5000);
      const cleanup=()=>{clearTimeout(timeout);decoder.removeEventListener(name,done);decoder.removeEventListener("error",failed);};
      const done=()=>{cleanup();resolve();};const failed=()=>{cleanup();reject(new Error("thumbnail decode"));};decoder.addEventListener(name,done,{once:true});decoder.addEventListener("error",failed,{once:true});});
    void(async()=>{try{await wait("loadeddata");for(let n=0;n<8&&!cancelled;n++){
      const time=Math.min(duration-.05,(n+.5)*duration/8);const seeking=wait("seeked");decoder.currentTime=Math.max(0,time);await seeking;
      canvas.getContext("2d")?.drawImage(decoder,0,0,canvas.width,canvas.height);frames.push(canvas.toDataURL("image/jpeg",.65));
    }if(!cancelled)setThumbnails(frames);}catch{/* Preview remains usable if a thumbnail fails. */}finally{decoder.removeAttribute("src");decoder.load();}})();
    return()=>{cancelled=true;decoder.removeAttribute("src");decoder.load();};
  },[source,duration,sourceHeight,sourceWidth]);
  // Boundary previews seek the decoder without moving the playback cursor.
  const seek=useCallback((time:number,moveCursor=true)=>{const element=video.current;if(!element)return;const target=clamp(time,0,Math.max(0,duration-.001));boundaryPreview.current=!moveCursor;element.currentTime=target;if(moveCursor)setPosition(target);},[duration]);
  const updateStart=(value:number)=>{const t=clamp(value,0,Math.max(0,end-.1));video.current?.pause();setStart(t);seek(t,false);};
  const updateEnd=(value:number)=>{const t=clamp(value,start+.1,duration);video.current?.pause();setEnd(t);seek(t,false);};
  const trimKey=(e:React.KeyboardEvent<HTMLInputElement>,update:(value:number)=>void)=>{
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;
    e.preventDefault();update(Number(e.currentTarget.value)+(["ArrowRight","ArrowUp"].includes(e.key)?.1:-.1));
  };
  const scrubTo=(e:ReactPointerEvent<HTMLDivElement>)=>{const bounds=e.currentTarget.getBoundingClientRect();seek(clamp((e.clientX-bounds.left-TRIM_HANDLE_WIDTH/2)/Math.max(1,bounds.width-TRIM_HANDLE_WIDTH),0,1)*duration);};
  const beginTrim=(e:ReactPointerEvent<HTMLInputElement>)=>{if(e.button!==0||busy||!ready)return;video.current?.pause();};
  const beginScrub=(e:ReactPointerEvent<HTMLDivElement>)=>{if(e.button!==0||busy||!ready||(e.target as HTMLElement).tagName==="INPUT")return;
    e.preventDefault();video.current?.pause();scrub.current=e.pointerId;e.currentTarget.setPointerCapture(e.pointerId);scrubTo(e);};
  const finishScrub=(e:ReactPointerEvent<HTMLDivElement>)=>{if(scrub.current!==e.pointerId)return;scrubTo(e);scrub.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);};
  const editCrop=()=>{video.current?.pause();setCrop(appliedCrop??{x:0,y:0,w:1,h:1});setCropOn(true);};
  const applyCrop=()=>{const p=cropPixels(crop);setAppliedCrop({x:p.x/sourceWidth,y:p.y/sourceHeight,w:p.width/sourceWidth,h:p.height/sourceHeight});setCropOn(false);};
  const cancelCrop=()=>{setCropOn(false);setCrop(appliedCrop??{x:0,y:0,w:1,h:1});};
  const togglePlay=async()=>{const element=video.current;if(!element)return;if(!element.paused){element.pause();return;}
    const resume=boundaryPreview.current?position:element.currentTime;boundaryPreview.current=false;
    element.currentTime=resume<start||resume>=end-.03?start:resume;
    try{await element.play();setError("");}catch(e){setError(`Не удалось воспроизвести запись: ${String(e)}`);}};
  const close=()=>{if(native)void getCurrentWindow().close();};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(cropOn&&e.key==="Escape"){e.preventDefault();cancelCrop();return;}if(cropOn&&e.key==="Enter"){e.preventDefault();applyCrop();return;}
    if(e.target instanceof HTMLElement&&e.target.closest("input,select,button"))return;
    if(e.code==="Space"){e.preventDefault();void togglePlay();}if(e.key==="Escape"&&!busy)close();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);});
  const saveVideo=async(loc?:{name:string;path:string})=>{
    if(!status||!ready||busy||cropOn)return;setError("");video.current?.pause();setDialogBusy(true);
    try{const path=loc?await invoke<string>("snipcast_capture_save_path",{dir:loc.path,ext:format}):await save({defaultPath:`Запись ${new Date().toISOString().slice(0,10)}.${format}`,filters:[{name:format==="gif"?"GIF-анимация":"Видео MP4",extensions:[format]}]});
      if(!path)return;
      await invoke<string>("snipcast_video_export",{path,options:{startMs:Math.round(start*1000),endMs:Math.round(end*1000),...pixels,format,quality,gifWidth,gifFps}});await getCurrentWindow().close();
    }catch(e){setError(String(e));}finally{setDialogBusy(false);}
  };
  saveAction.current=saveVideo;
  useEffect(()=>{
    const cancel=()=>{if(hold.current)clearTimeout(hold.current.timer);hold.current=null;setQuickOpen(false);setHoverQuick(null);};
    const move=(e:PointerEvent)=>{if(!hold.current?.fired)return;const el=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>("[data-video-quick]");setHoverQuick(el?Number(el.dataset.videoQuick):null);};
    const finish=(e:PointerEvent)=>{const h=hold.current;if(!h)return;hold.current=null;clearTimeout(h.timer);if(!h.fired)return;
      setQuickOpen(false);setHoverQuick(null);const el=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>("[data-video-quick]");
      const loc=el?config?.screenshotQuickLocations?.[Number(el.dataset.videoQuick)]:undefined;if(loc?.path)void saveAction.current(loc);
    };
    window.addEventListener("pointerup",finish);window.addEventListener("pointermove",move);window.addEventListener("pointercancel",cancel);window.addEventListener("blur",cancel);
    return()=>{if(hold.current)clearTimeout(hold.current.timer);window.removeEventListener("pointerup",finish);window.removeEventListener("pointermove",move);window.removeEventListener("pointercancel",cancel);window.removeEventListener("blur",cancel);};
  },[config]);
  const savePointerDown=(e:ReactPointerEvent<HTMLButtonElement>)=>{if(e.button!==0||busy||cropOn||!ready)return;suppressClick.current=false;
    e.currentTarget.setPointerCapture(e.pointerId);const h={timer:0,fired:false};hold.current=h;h.timer=window.setTimeout(()=>{h.fired=true;suppressClick.current=true;setQuickOpen(true);},250);
  };
  const saveClick=()=>{if(suppressClick.current){suppressClick.current=false;return;}void saveVideo();};
  const beginCrop=(e:ReactPointerEvent<HTMLDivElement>)=>{if(e.button!==0||busy)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
    drag.current={x:e.clientX,y:e.clientY,original:{...crop},handle:(e.target as HTMLElement).dataset.handle??"move"};};
  const moveCrop=(e:ReactPointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d)return;const dx=(e.clientX-d.x)/view.w,dy=(e.clientY-d.y)/view.h,c=d.original;
    const minw=16/sourceWidth,minh=16/sourceHeight;let left=c.x,top=c.y,right=c.x+c.w,bottom=c.y+c.h;
    if(d.handle==="move"){left=clamp(c.x+dx,0,1-c.w);top=clamp(c.y+dy,0,1-c.h);right=left+c.w;bottom=top+c.h;}
    else{if(d.handle.includes("w"))left=clamp(c.x+dx,0,right-minw);if(d.handle.includes("e"))right=clamp(c.x+c.w+dx,left+minw,1);
      if(d.handle.includes("n"))top=clamp(c.y+dy,0,bottom-minh);if(d.handle.includes("s"))bottom=clamp(c.y+c.h+dy,top+minh,1);}
    setCrop({x:left,y:top,w:right-left,h:bottom-top});};
  // Range-thumb centers travel through width minus the thumb width. Share this
  // geometry with the frame/playhead so the blue borders stop before the handles.
  const timelinePosition=(time:number)=>{const fraction=duration?clamp(time/duration,0,1):0;return `calc(${fraction*100}% + ${TRIM_HANDLE_WIDTH/2-fraction*TRIM_HANDLE_WIDTH}px)`;};
  const rangeStyle={"--trim-handle-width":`${TRIM_HANDLE_WIDTH}px`,"--trim-start":timelinePosition(start),"--trim-end":timelinePosition(end),"--play-position":timelinePosition(position)} as React.CSSProperties;
  return <div className="video-editor">
    <header className="video-editor__title" data-tauri-drag-region><span><VideoIcon name="video"/>Обрезка видео</span><button className="video-icon-button" aria-label="Закрыть редактор" disabled={busy} onClick={close}><VideoIcon name="close"/></button></header>
    <div className="video-preview" ref={preview}>
      <div className="video-preview__image" style={{width:view.w,height:view.h}}>
        {source?<video ref={video} src={source} crossOrigin="anonymous" preload="metadata" playsInline
          style={visibleCrop?{width:sourceWidth*view.w/pixels.width,height:sourceHeight*view.h/pixels.height,transform:`translate(${-pixels.x*view.w/pixels.width}px, ${-pixels.y*view.h/pixels.height}px)`}:undefined}
          onClick={()=>{if(!cropOn&&!busy)void togglePlay();}}
          onTimeUpdate={e=>{const el=e.currentTarget;if(!el.paused&&el.currentTime>=end){el.pause();el.currentTime=Math.min(end,duration-.001);}if(!boundaryPreview.current&&scrub.current===null)setPosition(el.currentTime);}}
          onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onError={()=>setError("Не удалось открыть записанное видео")}/>:<span className="video-empty">{error||"Загрузка записи…"}</span>}
        {cropOn?<div className="video-crop" style={{left:`${crop.x*100}%`,top:`${crop.y*100}%`,width:`${crop.w*100}%`,height:`${crop.h*100}%`}}
          onPointerDown={beginCrop} onPointerMove={moveCrop} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
          <span className="video-crop__dimensions">{draftPixels.width} × {draftPixels.height}</span>
          {["nw","n","ne","e","se","s","sw","w"].map(h=><button key={h} className={`video-crop__handle video-crop__handle--${h}`} data-handle={h} aria-label={`Размер обрезки: ${h}`} disabled={busy}
            onKeyDown={e=>{if(!e.key.startsWith("Arrow"))return;e.preventDefault();const step=e.shiftKey?10:2;
              const dx=(e.key==="ArrowLeft"?-step:e.key==="ArrowRight"?step:0)/sourceWidth,dy=(e.key==="ArrowUp"?-step:e.key==="ArrowDown"?step:0)/sourceHeight;
              setCrop(c=>{let left=c.x,top=c.y,right=c.x+c.w,bottom=c.y+c.h;
                if(h.includes("w"))left=clamp(left+dx,0,right-16/sourceWidth);if(h.includes("e"))right=clamp(right+dx,left+16/sourceWidth,1);
                if(h.includes("n"))top=clamp(top+dy,0,bottom-16/sourceHeight);if(h.includes("s"))bottom=clamp(bottom+dy,top+16/sourceHeight,1);
                return{x:left,y:top,w:right-left,h:bottom-top};});}}/>)}</div>:null}
      </div>
      {!playing&&!cropOn?<button className="video-preview-play" aria-label="Запустить предпросмотр" disabled={busy||!ready} onClick={()=>void togglePlay()}><VideoIcon name="play"/></button>:null}
      <div className="video-crop-actions">
        {cropOn?<><button className="video-crop-apply" disabled={busy} onClick={applyCrop}>Применить обрезку</button><button disabled={busy} onClick={cancelCrop}>Отменить обрезку</button></>:<>
          <button className="video-crop-toggle" disabled={busy||!ready} onClick={editCrop}><VideoIcon name="crop"/>{appliedCrop?"Изменить обрезку":"Обрезать кадр"}</button>
          {appliedCrop?<button disabled={busy} onClick={()=>{setAppliedCrop(null);}}>Сбросить обрезку</button>:null}
        </>}
      </div>
      {appliedCrop&&!cropOn?<span className="video-crop-applied" role="status">Кадр обрезан · {pixels.width} × {pixels.height}</span>:null}
    </div>
    <div className="video-timeline" style={rangeStyle}>
      <div className="video-timeline__times"><label>Начало <input aria-label="Начало фрагмента, секунды" type="number" min="0" max={Math.max(0,end-.1)} step="0.1" value={Number(start.toFixed(1))} disabled={busy||!ready} onChange={e=>updateStart(Number(e.target.value))}/><span>с</span></label>
        <span className="video-timeline__duration">Выбрано {selected.toFixed(1).replace(".",",")} с</span>
        <label>Конец <input aria-label="Конец фрагмента, секунды" type="number" min={start+.1} max={duration} step="0.1" value={Number(end.toFixed(1))} disabled={busy||!ready} onChange={e=>updateEnd(Number(e.target.value))}/><span>с</span></label></div>
      <div className="video-filmstrip" onPointerDown={beginScrub} onPointerMove={e=>{if(scrub.current===e.pointerId)scrubTo(e);}} onPointerUp={finishScrub}
        onPointerCancel={()=>{scrub.current=null;}} onLostPointerCapture={()=>{scrub.current=null;}}>
        <div className="video-filmstrip__frames" aria-hidden>{Array.from({length:8},(_,n)=><div key={n}>{thumbnails[n]?<img src={thumbnails[n]} alt=""/>:<span/>}</div>)}</div>
        <div className="video-filmstrip__shade video-filmstrip__shade--left"/><div className="video-filmstrip__shade video-filmstrip__shade--right"/><div className="video-filmstrip__selection"/>
        <input className="video-trim-range" type="range" aria-label="Начало фрагмента" min={0} max={duration||1} step="0.001" value={start} disabled={busy||!ready} onPointerDown={beginTrim} onKeyDown={e=>trimKey(e,updateStart)} onChange={e=>updateStart(Number(e.target.value))}/>
        <input className="video-trim-range" type="range" aria-label="Конец фрагмента" min={0} max={duration||1} step="0.001" value={end} disabled={busy||!ready} onPointerDown={beginTrim} onKeyDown={e=>trimKey(e,updateEnd)} onChange={e=>updateEnd(Number(e.target.value))}/>
        <div className="video-filmstrip__playhead"/>
      </div>
      <div className="video-transport"><button className="video-play-button" aria-label={playing?"Пауза":"Воспроизвести"} title="Плей / пауза (Пробел)" disabled={!ready||busy||cropOn} onClick={()=>void togglePlay()}><VideoIcon name={playing?"pause":"play"}/>{playing?"Пауза":"Плей"}</button>
        <span className="video-time">{clock(position)} <span>/ {clock(duration)}</span></span><span className="video-transport__details">{pixels.width} × {pixels.height} · {status?.fps??30} кадров/с{status?.audio?" · со звуком":""}</span></div>
    </div>
    <footer className="video-export"><label>Формат <span className="video-format">{["mp4","gif"].map(f=><button key={f} aria-pressed={format===f} disabled={busy} onClick={()=>{setFormat(f);}}>{f.toUpperCase()}</button>)}</span></label>
      {format==="mp4"?<label>Качество <ThemedSelect label="Качество видео" value={quality} disabled={busy} onChange={setQuality} options={[{value:"small",label:"Компактно"},{value:"balanced",label:"Баланс"},{value:"sharp",label:"Чёткий текст"}]}/></label>:<><label>Ширина <ThemedSelect label="Ширина GIF" value={String(gifWidth)} disabled={busy} onChange={v=>setGifWidth(Number(v))} options={[480,640,800,960].map(w=>({value:String(w),label:String(w)}))}/></label><label>Частота <ThemedSelect label="Частота GIF" value={String(gifFps)} disabled={busy} onChange={v=>setGifFps(Number(v))} options={[{value:"10",label:"10 кадров/с"},{value:"15",label:"15 кадров/с"}]}/></label></>}
      <span className="video-export__size">{format==="mp4"?`≈ ${size(estimate)}`:"GIF без звука"}</span>
      <div className="video-save-wrap"><button className="video-save" disabled={!ready||busy||cropOn||selected<.1} title="Нажмите для сохранения, удерживайте для быстрых мест" onPointerDown={savePointerDown} onClick={saveClick}><VideoIcon name="save"/>{status?.phase==="exporting"?`Сохранение ${status.exportPercent}%`:dialogBusy?"Сохранение…":`Сохранить ${format.toUpperCase()}`}</button>{quickOpen?<div className="video-quick" role="menu" aria-label="Быстрые места сохранения">{config?.screenshotQuickLocations?.length?config.screenshotQuickLocations.map((loc,i)=><button type="button" role="menuitem" key={`${loc.path}-${i}`} data-video-quick={i} className={hoverQuick===i?"is-hover":""} onClick={()=>void saveVideo(loc)}><strong>{loc.name}</strong><span>{loc.path}</span></button>):<div className="video-quick__empty">Места не настроены</div>}</div>:null}</div>
      {status?.phase==="exporting"?<button onClick={()=>void invoke("snipcast_video_cancel_export")}>Отменить сохранение</button>:null}
    </footer>
    {(error||status?.error)?<div className="video-message video-message--error" role="alert">{error||status?.error}</div>:null}
  </div>;
}
