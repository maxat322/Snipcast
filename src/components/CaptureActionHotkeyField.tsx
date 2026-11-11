import {HotkeyInput} from './HotkeyInput';
import {useEffect,useMemo,useState,useRef} from "react";
import {listen} from "@tauri-apps/api/event";
import type {RecordedKey} from "../hotkeyFormat";
import {invoke} from "@tauri-apps/api/core";
import {createHotkeyRecorder,tauriHotkeyToDisplay} from "../hotkeyFormat";
import {ClearHotkeyButton} from "./ClearHotkeyButton";
// Serialize native pause/resume across fields and rapid focus changes.
let recordingTransition:Promise<unknown>=Promise.resolve();
export function CaptureActionHotkeyField({label,value,onSave,disabled=false,compact=false,placeholder}:{compact?:boolean;label:string;value:string;onSave:(value:string)=>Promise<void>;disabled?:boolean;placeholder?:string}){
  const recorder=useMemo(createHotkeyRecorder,[]),[recording,setRecording]=useState(false),[focused,setFocused]=useState(false),[saving,setSaving]=useState(false);
  const pending=useRef(false);
  const save=async(value:string)=>{if(pending.current)return;pending.current=true;setSaving(true);try{await onSave(value);}finally{pending.current=false;setSaving(false);setRecording(false);}};
  const receive=useRef<(event:RecordedKey)=>void>(()=>{});
  receive.current=event=>{const shortcut=recorder.record(event);if(shortcut)void save(shortcut).catch(()=>{});};
  useEffect(()=>{if(!focused)return;let active=true;
    const kinds=["palette_hotkey","screenshot_hotkey","preset_hotkeys","suggestions_hotkeys","commands_hotkeys"];
    const off=listen<RecordedKey>("snipcast://hotkey-recorded",event=>{if(active)receive.current(event.payload)});
    recordingTransition=recordingTransition.then(async()=>{await off;if(!active)return;await Promise.all(kinds.map(kind=>invoke(`snipcast_${kind}_pause`).catch(()=>{})));if(active)await invoke("snipcast_hotkey_recording",{active:true});}).catch(()=>{});
    return()=>{active=false;void off.then(unlisten=>unlisten());recordingTransition=recordingTransition.then(()=>invoke("snipcast_hotkey_recording",{active:false}).catch(()=>{})).then(()=>Promise.all(kinds.map(kind=>invoke(`snipcast_${kind}_resume`).catch(()=>{}))));};
  },[focused]);
  const key=(e:React.KeyboardEvent<HTMLInputElement>)=>{e.preventDefault();e.stopPropagation();const shortcut=recorder.record(e.nativeEvent);if(shortcut&&!saving)void save(shortcut).catch(()=>{});};
  return <div className={compact?"settings__quick-row commands-settings__hotkey":"settings__option settings__option--hotkey"}>{!compact&&<span className="settings__option-label">{label}</span>}
    <HotkeyInput onRecordMouse={value=>save(value)} type="text" readOnly className="settings__hotkey-input" aria-label={`Горячая клавиша: ${label}`} value={recording?"":tauriHotkeyToDisplay(value)}
      placeholder={recording?"Нажмите комбинацию…":placeholder??(compact?"Назначить":"Не назначена")} onFocus={()=>{recorder.reset();setFocused(true);setRecording(true);}} onBlur={()=>{setFocused(false);setRecording(false);}} onKeyDown={key} onKeyUp={key} disabled={saving||disabled}/>
    <ClearHotkeyButton label={label} disabled={!value||saving||disabled} onClick={()=>void save("").catch(()=>{})}/>
  </div>;
}
