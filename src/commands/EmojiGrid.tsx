import {useLayoutEffect,useMemo,useRef,useState} from 'react';
import type emojis from './emoji.json';

// Reuse the palette rows while mounting only rows near the viewport.
export function EmojiGrid({items,columns,selected,tone,onChoose,popularCount,grouped}:{items:typeof emojis;columns:number;selected:number;tone:string;onChoose:(index:number)=>void;popularCount:number;grouped:boolean}) {
  const viewport=useRef<HTMLDivElement>(null);
  const [view,setView]=useState({top:0,height:400});
  const layout=useMemo(()=>{
    const rows:{top:number;start:number;end:number}[]=[],headers:{top:number;label:string}[]=[];let top=0;
    const add=(start:number,end:number,label?:string)=>{if(start===end)return;if(label){headers.push({top,label});top+=24}for(let i=start;i<end;i+=columns){rows.push({top,start:i,end:Math.min(end,i+columns)});top+=78}};
    if(grouped){add(0,popularCount,'Часто используемые');add(popularCount,items.length,'Все')}else add(0,items.length);
    return {rows,headers,height:Math.max(0,top-8)};
  },[items,columns,popularCount,grouped]);
  useLayoutEffect(()=>{const el=viewport.current!;const measure=()=>setView({top:el.scrollTop,height:el.clientHeight});const observer=new ResizeObserver(measure);observer.observe(el);measure();return()=>observer.disconnect()},[]);
  useLayoutEffect(()=>{const el=viewport.current!;el.scrollTop=0;setView(v=>({...v,top:0}));},[items,columns]);
  useLayoutEffect(()=>{const el=viewport.current!,row=layout.rows.find(r=>selected>=r.start&&selected<r.end);if(!row)return;const top=row.top+12;if(top<el.scrollTop)el.scrollTop=Math.max(0,top-12);else if(top+70>el.scrollTop+el.clientHeight)el.scrollTop=top+82-el.clientHeight;setView(v=>({...v,top:el.scrollTop}));},[selected,layout]);
  return <div ref={viewport} className="commands__emoji" role="listbox" onScroll={e=>setView({top:e.currentTarget.scrollTop,height:e.currentTarget.clientHeight})}>
    <div style={{height:layout.height,position:'relative'}}>
      {layout.headers.map(h=><div key={h.label} className="palette__item-preview" style={{position:'absolute',top:h.top,left:0}}>{h.label}</div>)}
      {layout.rows.filter(r=>r.top+78>=view.top-156&&r.top<=view.top+view.height+156).map(row=><div key={row.start} style={{position:'absolute',top:row.top,left:0,right:0,display:'grid',gap:8,gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`,gridAutoRows:70}}>
        {items.slice(row.start,row.end).map((e,offset)=>{const index=row.start+offset;return <button key={index} title={e.name} role="option" aria-label={e.name} aria-posinset={index+1} aria-setsize={items.length} aria-selected={selected===index} data-selected={selected===index} className={'palette__item '+(selected===index?'palette__item--kb':'')} onClick={()=>onChoose(index)}>{e.emoji+(e.tone?tone:'')}</button>})}
      </div>)}
    </div>
  </div>;
}
