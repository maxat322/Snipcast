import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {HotkeyInput} from './HotkeyInput';
import {ClearHotkeyButton} from './ClearHotkeyButton';
import {createHotkeyRecorder, tauriHotkeyToDisplay} from '../hotkeyFormat';

export function SecondaryHotkey({primaryClear, label, kind, value, disabled, pause, resume, onSave}: {
  primaryClear:ReactNode; label:string; kind:string; value:string; disabled:boolean;
  pause:()=>void; resume:()=>void; onSave:(value:string)=>Promise<boolean>;
}) {
  const [shown,setShown]=useState(Boolean(value));
  const [saving,setSaving]=useState(false);
  const container=useRef<HTMLSpanElement>(null);
  const recorder=useMemo(createHotkeyRecorder,[]);
  const pending=useRef<Promise<boolean>|null>(null);
  useEffect(()=>{setShown(Boolean(value));},[value]);
  useEffect(()=>{if(disabled && !value)setShown(false);},[disabled,value]);
  const save=(next:string)=>{
    if(pending.current)return pending.current;
    setSaving(true);
    const task=onSave(next).finally(()=>{pending.current=null;setSaving(false);});
    pending.current=task;
    return task;
  };
  return <span ref={container} style={{display:'contents'}}>
    {shown ? <>
      <HotkeyInput type="text" readOnly className="settings__hotkey-input"
        value={tauriHotkeyToDisplay(value)} disabled={disabled}
        aria-label={`Второе сочетание ${kind}`} placeholder="Нажмите сочетание…"
        onFocus={()=>{recorder.reset();pause();}}
        onBlur={()=>{recorder.reset();void (pending.current??Promise.resolve()).finally(()=>{
          const active=document.activeElement;
          if(active instanceof HTMLInputElement && container.current?.parentElement?.contains(active))return;
          resume();
        });}}
        onRecordMouse={async next=>{await save(next);}}
        onKeyDown={e=>{e.preventDefault();if(e.code==='Escape'){e.currentTarget.blur();return;}const next=recorder.record(e.nativeEvent);if(next)void save(next);}}
        onKeyUp={e=>{e.preventDefault();const next=recorder.record(e.nativeEvent);if(next)void save(next);}}/>
      {primaryClear}
      <ClearHotkeyButton label={`${label} (второе сочетание)`} disabled={disabled||saving}
        onClick={()=>{if(!value)setShown(false);else void save('').then(ok=>{if(ok)setShown(false);});}}/>
    </> : <><button type="button" className="settings__ghost settings__hotkey-clear"
      aria-label={`Добавить второе сочетание: ${label}`} title={`Добавить второе сочетание: ${label}`}
      disabled={disabled} onClick={()=>{setShown(true);requestAnimationFrame(()=>container.current?.querySelector('input')?.focus());}}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
    </button>{primaryClear}</>}
  </span>;
}
