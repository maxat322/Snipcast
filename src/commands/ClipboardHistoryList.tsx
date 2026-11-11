import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {clipboardKindIcons,type Clip} from './model';

const OVERSCAN=180;

type Props={
 clips:Clip[];
 selected:number;
 selection:number[];
 loading:boolean;
 error:string;
 resetKey:string;
 onSelect:(index:number,additive:boolean)=>void;
 onPaste:()=>void;
 onNearEnd:(list:HTMLDivElement)=>void;
};

// Keep the palette rows and their styling, but mount only rows near the viewport.
export function ClipboardHistoryList({clips,selected,selection,loading,error,resetKey,onSelect,onPaste,onNearEnd}:Props){
 const viewport=useRef<HTMLDivElement>(null);
 const [view,setView]=useState({top:0,height:400});
 const [compact,setCompact]=useState(()=>document.documentElement.dataset.paletteDensity==='compact');
 const rowHeight=compact?23:29,headerHeight=compact?14:16,padding=compact?4:8;
 const layout=useMemo(()=>{
  let top=padding;
  const rows=clips.map((clip,index)=>{
   const previous=clips[index-1];
   const header=index===0||clip.pinned!==previous.pinned||new Date(clip.created).toDateString()!==new Date(previous.created).toDateString()
    ?clip.pinned?'Закреплённые':new Date(clip.created).toLocaleDateString('ru-RU'):null;
   const row={index,top,header,height:(header?headerHeight:0)+rowHeight};
   top+=row.height;
   return row;
  });
  return {rows,height:top+padding};
 },[clips,compact,headerHeight,padding,rowHeight]);
 useEffect(()=>{
  const root=document.documentElement;
  const observer=new MutationObserver(()=>setCompact(root.dataset.paletteDensity==='compact'));
  observer.observe(root,{attributes:true,attributeFilter:['data-palette-density']});
  return()=>observer.disconnect();
 },[]);
 useLayoutEffect(()=>{
  const element=viewport.current!;
  const measure=()=>setView({top:element.scrollTop,height:element.clientHeight});
  const observer=new ResizeObserver(measure);observer.observe(element);measure();
  return()=>observer.disconnect();
 },[]);
 useLayoutEffect(()=>{
  const element=viewport.current!;element.scrollTop=0;
  setView({top:0,height:element.clientHeight});
 },[resetKey]);
 useLayoutEffect(()=>{
  const element=viewport.current!,row=layout.rows[selected];if(!row)return;
  const itemTop=row.top+(row.header?headerHeight:0);
  let top=element.scrollTop;
  if(itemTop<top+padding)top=Math.max(0,itemTop-padding);
  else if(itemTop+rowHeight>top+element.clientHeight-padding)top=itemTop+rowHeight+padding-element.clientHeight;
  if(top!==element.scrollTop)element.scrollTop=top;
  const height=element.clientHeight;
  setView(current=>current.top===element.scrollTop&&current.height===height?current:{top:element.scrollTop,height});
 },[selected,compact,resetKey]);
 const visible=layout.rows.filter(row=>row.top+row.height>=view.top-OVERSCAN&&row.top<=view.top+view.height+OVERSCAN);
 return <div ref={viewport} className="commands__history" data-loaded-count={clips.length} onScroll={event=>{
  const list=event.currentTarget;setView(current=>current.top===list.scrollTop&&current.height===list.clientHeight?current:{top:list.scrollTop,height:list.clientHeight});onNearEnd(list);
 }}>
  <ul className="palette__list" role="listbox" aria-multiselectable style={{height:layout.height,position:'relative',overflow:'visible'}}>
   {visible.map(row=>{const clip=clips[row.index],chosen=selection.includes(clip.id),highlighted=chosen||selected===row.index;return <li key={clip.id} style={{position:'absolute',top:row.top,left:padding,right:padding}}>
    <div className="palette__item-preview">{row.header}</div>
    <button role="option" aria-posinset={row.index+1} aria-setsize={clips.length} aria-selected={chosen} data-selected={selected===row.index} className={'palette__item '+(highlighted?'palette__item--kb':'')} onClick={event=>onSelect(row.index,event.shiftKey)} onDoubleClick={onPaste}>
     <span className="palette__item-row"><span aria-hidden="true">{clipboardKindIcons[clip.kind]??clipboardKindIcons.text}</span><span className="palette__item-title">{clip.title}</span></span>
    </button>
   </li>})}
  </ul>
  {!clips.length&&<p className="palette__empty">{loading?'Загрузка…':error?'Не удалось загрузить историю':'История пуста'}</p>}
 </div>;
}
