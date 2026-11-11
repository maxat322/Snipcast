import {useLayoutEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import type {Clip} from './model';

export function withDeadline<T>(request:Promise<T>, milliseconds=8000):Promise<T> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('История не ответила. Повторите загрузку.')),milliseconds);
    request.then(resolve,reject).finally(()=>clearTimeout(timer));
  });
}

// The first page is small for a fast first paint; later pages use the backend
// maximum so held arrow navigation does not catch up with the loaded tail.
const FIRST_PAGE=10,PAGE=100;

// One request per view. Change notifications coalesce instead of continually
// invalidating the result the user is waiting for. Old views cannot update this one.
export function useClipboardHistory(active:boolean,query:string,kind:string,epoch:number) {
  const [clips,setClips]=useState<Clip[]>([]),[total,setTotal]=useState(0);
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  const refresh=useRef<(append?:boolean)=>Promise<void>>(async()=>{});
  useLayoutEffect(()=>{
    let disposed=false,flight:Promise<void>|null=null,dirty=false,items:Clip[]=[];
    setClips([]);setTotal(0);setLoading(active);setError('');
    if(!active){refresh.current=async()=>{};return;}
    const fetch=async(append=false,pageLimit?:number):Promise<void>=>{
      if(disposed)return;
      if(flight){if(!append)dirty=true;return flight;}
      let preload=false;
      setLoading(true);setError('');
      flight=(async()=>{
        try {
          const page=(offset:number,limit:number)=>withDeadline(invoke<{items:Clip[];total:number;status:string}>('snipcast_history_list',{query,kind,offset,limit}));
          const merge=(base:Clip[],add:Clip[])=>{const seen=new Set(base.map(c=>c.id));return [...base,...add.filter(c=>!seen.has(c.id))]};
          let next:Clip[],res:{items:Clip[];total:number;status:string};
          if(append){
            res=await page(items.length,pageLimit??PAGE);
            next=merge(items,res.items);
          } else {
            // Перечитываем столько записей, сколько уже было загружено, иначе
            // новое копирование обрезало бы список под курсором до первой страницы.
            const want=Math.max(FIRST_PAGE,items.length);next=[];
            do {
              res=await page(next.length,Math.min(PAGE,want-next.length));
              if(disposed)return;
              next=merge(next,res.items);
            } while(res.items.length&&next.length<want&&next.length<res.total);
          }
          if(disposed)return;
          items=next;
          setClips(items);setTotal(res.total);setError(res.status||'');
          preload=!append&&items.length<res.total&&items.length<=FIRST_PAGE;
        } catch(e) {if(!disposed){dirty=false;setError(String(e));}}
        finally {flight=null;if(!disposed){setLoading(false);if(dirty){dirty=false;void fetch();}else if(preload)void fetch(true);}}
      })();
      return flight;
    };
    refresh.current=fetch;
    // Subscribe before reading, so changes during the first request are not lost.
    const off=listen('snipcast://clipboard-changed',()=>{if(!disposed)void fetch()});
    const timer=setTimeout(()=>void fetch(),query?100:0);
    return()=>{disposed=true;clearTimeout(timer);void off.then(stop=>stop());};
  },[active,query,kind,epoch]);
  return {clips,total,loading,error,refresh:(append=false)=>refresh.current(append)};
}
