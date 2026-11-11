import {useEffect,useRef,useState,type ComponentProps} from 'react';
import {listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
import {mouseEventToHotkey} from '../hotkeyFormat';
let transition:Promise<unknown>=Promise.resolve();
/** The existing input surface with mouse recording; the first focus click stays an ordinary click. */
export function HotkeyInput({onRecordMouse,onFocus,onBlur,onMouseDown,onMouseUp,onAuxClick,onContextMenu,disabled,...props}:ComponentProps<'input'> & {onRecordMouse:(value:string)=>void|Promise<void>}){
 const [focused,setFocused]=useState(false),input=useRef<HTMLInputElement>(null),pending=useRef(false),saveRef=useRef(onRecordMouse);saveRef.current=onRecordMouse;
 const record=useRef((value:string)=>{if(pending.current)return;pending.current=true;void Promise.resolve().then(()=>saveRef.current(value)).catch(()=>{}).finally(()=>{pending.current=false})});
 useEffect(()=>{
  const leave=()=>{if(document.activeElement===input.current)input.current?.blur()};
  const visibility=()=>{if(document.visibilityState==='hidden')leave()};
  window.addEventListener('blur',leave);document.addEventListener('visibilitychange',visibility);
  return()=>{window.removeEventListener('blur',leave);document.removeEventListener('visibilitychange',visibility)};
 },[]);
 useEffect(()=>{if(!focused||disabled)return;let active=true;
  const off=listen<string>('snipcast://mouse-hotkey-recorded',event=>{if(active&&document.activeElement===input.current)record.current(event.payload)});
  transition=transition.then(async()=>{await off;if(active)await invoke('snipcast_mouse_hotkey_recording',{active:true});}).catch(()=>{});
  return()=>{active=false;void off.then(stop=>stop());transition=transition.then(()=>invoke('snipcast_mouse_hotkey_recording',{active:false})).catch(()=>{});};
 },[focused,disabled]);
 return <input {...props} ref={input} disabled={disabled} onFocus={e=>{setFocused(true);onFocus?.(e)}} onBlur={e=>{setFocused(false);onBlur?.(e)}} onMouseDown={e=>{
  onMouseDown?.(e);if(e.defaultPrevented||document.activeElement!==e.currentTarget)return;
  const value=mouseEventToHotkey(e.nativeEvent);if(value){e.preventDefault();e.stopPropagation();record.current(value);}
 }} onMouseUp={e=>{if(focused&&e.button>=3)e.preventDefault();onMouseUp?.(e)}} onAuxClick={e=>{if(focused)e.preventDefault();onAuxClick?.(e)}} onContextMenu={e=>{e.preventDefault();onContextMenu?.(e)}}/>;
}
