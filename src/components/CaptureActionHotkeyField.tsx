import {useEffect,useMemo,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {createHotkeyRecorder,tauriHotkeyToDisplay} from "../hotkeyFormat";
import {ClearHotkeyButton} from "./ClearHotkeyButton";
export function CaptureActionHotkeyField({label,value,onSave,disabled=false}:{label:string;value:string;onSave:(value:string)=>Promise<void>;disabled?:boolean}){
  const recorder=useMemo(createHotkeyRecorder,[]),[recording,setRecording]=useState(false),[focused,setFocused]=useState(false),[saving,setSaving]=useState(false);
  useEffect(()=>{if(!focused)return;const kinds=["palette_hotkey","screenshot_hotkey","preset_hotkeys"];
    const paused=Promise.all(kinds.map(kind=>invoke(`snipcast_${kind}_pause`).catch(()=>{})));
    return()=>{void paused.then(()=>Promise.all(kinds.map(kind=>invoke(`snipcast_${kind}_resume`).catch(()=>{}))));};
  },[focused]);
  const save=async(value:string)=>{setSaving(true);try{await onSave(value);}finally{setSaving(false);setRecording(false);}};
  const key=(e:React.KeyboardEvent<HTMLInputElement>)=>{e.preventDefault();e.stopPropagation();const shortcut=recorder.record(e.nativeEvent);if(shortcut&&!saving)void save(shortcut);};
  return <div className="settings__option settings__option--hotkey"><span className="settings__option-label">{label}</span>
    <input type="text" readOnly className="settings__hotkey-input" aria-label={`Горячая клавиша: ${label}`} value={recording?"":tauriHotkeyToDisplay(value)}
      placeholder={recording?"Нажмите комбинацию…":"Не назначена"} onFocus={()=>{recorder.reset();setFocused(true);setRecording(true);}} onBlur={()=>{setFocused(false);setRecording(false);}} onKeyDown={key} onKeyUp={key} disabled={saving||disabled}/>
    <ClearHotkeyButton label={label} disabled={!value||saving||disabled} onClick={()=>void save("")}/>
  </div>;
}
