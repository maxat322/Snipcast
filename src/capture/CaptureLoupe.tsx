import { useLayoutEffect, useRef, useState,useMemo } from "react";
import type { Pt } from "./shapes";
import { floatingPosition, formatPixel,monitorRect, type CaptureGeometry,type ScreenMonitor } from "./captureAssist";

export type PixelSample = { r: number; g: number; b: number; x: number; y: number };
type Props = {
  source: HTMLCanvasElement; pointer: Pt; info: CaptureGeometry & {monitors?:ScreenMonitor[]};
  viewport: { w: number; h: number }; format: "hex" | "rgb";
  onSample: (sample: PixelSample | null) => void;
};

export function CaptureLoupe({ source, pointer, info, viewport, format, onSample }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const block = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 226, h: 254 });
  const pixel=useMemo(()=>({x:Math.max(0,Math.min(source.width-1,Math.floor(pointer.x*source.width/viewport.w))),
    y:Math.max(0,Math.min(source.height-1,Math.floor(pointer.y*source.height/viewport.h)))}),[source,pointer,viewport.w,viewport.h]);
  const sample=useMemo<PixelSample|null>(()=>{
    try{const src=source.getContext("2d");if(!src)return null;
      const [r,g,b]=src.getImageData(pixel.x,pixel.y,1,1).data;return {r,g,b,x:info.x+pixel.x,y:info.y+pixel.y};
    }catch{return null;}
  },[source,pixel,info.x,info.y]);
  useLayoutEffect(() => {
    const el = block.current;
    if(!el)return;
    const observer=new ResizeObserver(()=>setSize(prev=>prev.w===el.offsetWidth&&prev.h===el.offsetHeight?prev:{w:el.offsetWidth,h:el.offsetHeight}));
    observer.observe(el);return()=>observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const dest = canvas.current?.getContext("2d"), src = source.getContext("2d");
    if (!dest || !src) return;
    const {x,y}=pixel;
    dest.imageSmoothingEnabled = false;
    dest.clearRect(0,0,120,120);
    // Pad the viewport edge without shifting the pixel at the centre.
    const left = Math.max(0,x-7), top = Math.max(0,y-7);
    const right = Math.min(source.width,x+8), bottom = Math.min(source.height,y+8);
    dest.drawImage(source,left,top,right-left,bottom-top,(left-(x-7))*8,(top-(y-7))*8,(right-left)*8,(bottom-top)*8);
    onSample(sample);
  }, [source,pixel,sample,onSample]);
  useLayoutEffect(() => () => onSample(null), [onSample]);
  return <div ref={block} className="capture__loupe" style={floatingPosition(pointer,size.w,size.h,viewport,monitorRect(info.monitors??[],pointer,info,viewport))}>
    <div className="capture__loupe-image"><canvas ref={canvas} width={120} height={120} />
      <div className="capture__loupe-grid" /><div className="capture__loupe-centre" /></div>
    <div className="capture__loupe-panel">
      {sample ? <><div className="capture__loupe-coordinates"><span>X: {sample.x}</span><span>Y: {sample.y}</span></div>
        <div className="capture__loupe-color"><i style={{ background:formatPixel(sample.r,sample.g,sample.b,"hex") }} />
          <span>{formatPixel(sample.r,sample.g,sample.b,format)}</span></div></> : <span>Цвет недоступен</span>}
      <div className="capture__loupe-shortcuts">
        <div><kbd>Shift</kbd> RGB / HEX</div>
        <div><kbd>C</kbd> копировать цвет</div>
      </div>
    </div>
  </div>;
}
