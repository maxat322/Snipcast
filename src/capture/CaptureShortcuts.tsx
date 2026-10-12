import { memo, useLayoutEffect, useRef, type RefObject } from "react";
import { monitorRect, type ScreenMonitor } from "./captureAssist";
import type { Pt, ShapeKind } from "./shapes";

type Rect={x:number;y:number;w:number;h:number};
type Geometry={x:number;y:number;width:number;height:number;monitors?:ScreenMonitor[]};
export type HintMotion={move:((point:Pt)=>void)|null};
type Props={info:Geometry|null;viewport:{w:number;h:number};session:number;
  cursor:RefObject<Pt|null>;motion:RefObject<HintMotion>;selected:boolean;
  gesture?:string;editing:boolean;selectedShape:boolean;tool:ShapeKind|null;mode:"element"|"window"};
const overlaps=(a:Rect,b:Rect)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;

export const CaptureShortcuts=memo(function CaptureShortcuts(p:Props) {
  const panel=useRef<HTMLDivElement>(null);
  const corner=useRef(0),monitorKey=useRef("");
  useLayoutEffect(()=>{corner.current=0;monitorKey.current="";},[p.session]);
  useLayoutEffect(()=>{
    const el=panel.current;if(!el)return;
    let cached:{key:string;width:number;height:number;positions:Pt[]}|null=null;
    const move=(point:Pt)=>{
      const bounds=p.info?monitorRect(p.info.monitors??[],point,p.info,p.viewport):{x:0,y:0,...p.viewport};
      const key=`${bounds.x},${bounds.y},${bounds.w},${bounds.h}`;
      if(!cached||cached.key!==key){
        el.style.maxWidth=`${Math.max(1,bounds.w-32)}px`;
        el.style.maxHeight=`${Math.max(1,bounds.h-32)}px`;
        el.style.setProperty("--hint-row-height",bounds.h<650?"20px":"24px");
        el.style.fontSize=bounds.h<650?"11px":"12px";
        const width=el.offsetWidth,height=el.offsetHeight;
        const left=bounds.x+16,right=Math.max(left,bounds.x+bounds.w-width-16);
        const top=bounds.y+16,bottom=Math.max(top,bounds.y+bounds.h-height-16);
        cached={key,width,height,positions:[{x:left,y:bottom},{x:left,y:top},{x:right,y:top},{x:right,y:bottom}]};
      }
      const {width,height,positions}=cached;
      if(monitorKey.current!==key){monitorKey.current=key;corner.current=0;}
      const current=positions[corner.current]!;
      if(point.x>=current.x-12&&point.x<=current.x+width+12&&point.y>=current.y-12&&point.y<=current.y+height+12){
        const obstacles=Array.from(document.querySelectorAll<HTMLElement>(".capture__loupe,.capture__toolbar,.capture__opts"))
          .map(node=>{const r=node.getBoundingClientRect();return {x:r.x-8,y:r.y-8,w:r.width+16,h:r.height+16};});
        let best=corner.current,score=-Infinity;
        positions.forEach((pos,i)=>{
          const rect={...pos,w:width,h:height};
          const blocked=obstacles.some(other=>overlaps(rect,other));
          const distance=Math.hypot(point.x-pos.x-width/2,point.y-pos.y-height/2);
          const value=distance-(blocked?100000:0);
          if(value>score){score=value;best=i;}
        });
        corner.current=best;
      }
      const pos=positions[corner.current]!;
      const nextLeft=`${pos.x}px`,nextTop=`${pos.y}px`;
      if(el.style.left!==nextLeft)el.style.left=nextLeft;
      if(el.style.top!==nextTop)el.style.top=nextTop;
      if(el.style.bottom!=="auto")el.style.bottom="auto";
      if(el.dataset.corner!==String(corner.current))el.dataset.corner=String(corner.current);
    };
    p.motion.current.move=move;
    move(p.cursor.current??{x:0,y:0});
    const observer=new ResizeObserver(()=>{cached=null;move(p.cursor.current??{x:0,y:0});});observer.observe(el);
    return()=>{observer.disconnect();p.motion.current.move=null;};
  },[p.info,p.viewport,p.motion,p.cursor,p.session,p.selected,p.gesture,p.editing,p.tool]);
  const row=(keys:string,label:string)=><div key={keys}><kbd>{keys}</kbd><span>{label}</span></div>;
  const dragging=!!p.gesture;
  const escape=p.editing?"отменить редактирование":p.selectedShape?"снять выбор аннотации":p.tool?"выйти из инструмента":"отменить захват";
  return <div ref={panel} className="capture__shortcuts" data-mode={dragging?"drag":p.selected?"selected":p.mode}>
    {p.editing?<>{row("Enter","новая строка")}{row("Ctrl+Enter","завершить текст")}{row("Ctrl+Z","отменить ввод")}{row("Ctrl+Shift+Z","повторить ввод")}</>
    :dragging?<><div>Отпустите кнопку — завершить</div>
      {p.gesture==="draw"&&["line","arrow","freehand"].includes(p.tool??"")?row("Shift","рисовать горизонтально / вертикально"):null}
      {row("← ↑ ↓ →","курсор на 1 пиксель")}</>
    :p.selected?<>
      {row("C","копировать и закрыть")}{row("Enter","сохранить в файл")}{row("Пробел","закрепить область")}
      {row("1 2 ... 8","выбрать инструмент")}
      {row("Ctrl+Z","отменить действие")}{row("Ctrl+Shift+Z","повторить действие")}
      {p.selectedShape?row("Delete / Backspace","удалить аннотацию"):null}
      {["line","arrow","freehand"].includes(p.tool??"")?row("Shift","рисовать горизонтально / вертикально"):null}</>
    :<><div>Клик — выбрать предложенную область</div><div>Перетаскивание — выделить вручную</div>
      <div><kbd>Tab</kbd> элементы / окна <strong>{p.mode==="element"?"Элементы":"Окна"}</strong></div></>}
    {!p.editing&&!dragging?<>{row("A","весь монитор под курсором")}{row("← ↑ ↓ →","курсор на 1 пиксель")}</>:null}
    {row("Esc",dragging?(p.gesture==="draw"?"отменить рисование":"отменить выделение"):escape)}
  </div>;
});
