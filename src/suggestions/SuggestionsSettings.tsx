import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {CaptureActionHotkeyField} from "../components/CaptureActionHotkeyField";
import {DEFAULT_TEXT_SUGGESTIONS,type TextSuggestionsConfig} from "../types";
import "./suggestions.css";

export function SuggestionsSettings({value,onSave}:{value?:TextSuggestionsConfig;onSave:(value:TextSuggestionsConfig)=>Promise<void>}){
  const cfg={...DEFAULT_TEXT_SUGGESTIONS,...value};
  const [trigger,setTrigger]=useState(cfg.trigger),[minChars,setMinChars]=useState(String(cfg.minChars)),[excluded,setExcluded]=useState(cfg.excludedApps.join("\n")),[error,setError]=useState(""),[saving,setSaving]=useState(false),[status,setStatus]=useState("");
  const latest=useRef(cfg);latest.current=cfg;
  useEffect(()=>{setTrigger(cfg.trigger);setExcluded(cfg.excludedApps.join("\n"));},[cfg.trigger,JSON.stringify(cfg.excludedApps)]);
  useEffect(()=>setMinChars(String(cfg.minChars)),[cfg.minChars]);
  useEffect(()=>{let live=true,off:(()=>void)|undefined;
    void listen<{message:string}>("snipcast://suggestions-status",e=>{if(live)setStatus(e.payload.message);}).then(fn=>{if(live)off=fn;else fn();}).catch(()=>{});
    void invoke<{message:string}|null>("snipcast_suggestions_status").then(s=>{if(live)setStatus(s?.message??"");}).catch(()=>{});
    return()=>{live=false;off?.();};},[]);
  const patch=async(patch:Partial<TextSuggestionsConfig>)=>{setSaving(true);setError("");try{await onSave({...latest.current,...patch});}catch(e){setError(String(e));}finally{setSaving(false);}};
  const isMac=navigator.userAgent.includes("Mac");
  return <div className="suggestions-settings" role="group" aria-label="Подсказки во время ввода">
    <div className="settings__option"><span className="settings__option-label">Подсказки во время ввода</span>
      <button type="button" role="switch" aria-label="Подсказки во время ввода" aria-checked={cfg.enabled} className={`settings__toggle${cfg.enabled?" is-on":""}`} disabled={saving||isMac} onClick={()=>void patch({enabled:!cfg.enabled,...(!cfg.enabled&&cfg.mode==="trigger"&&!cfg.trigger?{trigger:DEFAULT_TEXT_SUGGESTIONS.trigger}:{})})}><span className="settings__toggle-knob"/></button>
    </div>
    {isMac?<p className="settings__screenshot-muted">Доступно в Windows.</p>:null}
    {cfg.enabled?<div className="suggestions-settings__details">
    <div className="settings__segment-row" role="radiogroup" aria-label="Режим подсказок">
      {([['trigger','По триггеру'],['automatic','Постоянно']] as const).map(([mode,label])=><button key={mode} type="button" role="radio" aria-checked={cfg.mode===mode}
        className={`settings__seg${cfg.mode===mode?" is-active":""}`} disabled={saving||isMac} onClick={()=>void patch({mode,...(mode==="trigger"&&!cfg.trigger?{trigger:DEFAULT_TEXT_SUGGESTIONS.trigger}:{})})}>{label}</button>)}
    </div>
    <div className="suggestions-settings__description">
    <div className="settings__option"><span className="settings__option-label">Поиск тексту</span>
      <button type="button" role="switch" aria-label="Поиск тексту" aria-checked={cfg.searchText} className={`settings__toggle${cfg.searchText?" is-on":""}`} disabled={saving||isMac} onClick={()=>void patch({searchText:!cfg.searchText})}><span className="settings__toggle-knob"/></button>
    </div>
    <p className="settings__screenshot-muted">Если выключено, поиск идёт только по названиям. Если включено — также по содержимому шаблонов.</p>
    </div>
    <div className="settings__option suggestions-settings__inline suggestions-settings__inline--count"><label className="settings__option-label" htmlFor="suggestions-min-chars">Количество символов для вызова Быстрой палитры</label>
      <input id="suggestions-min-chars" type="text" inputMode="numeric" maxLength={3} value={minChars} disabled={saving||isMac} onChange={e=>setMinChars(e.target.value)}
        onBlur={()=>{const count=Number(minChars);if(!Number.isInteger(count)||count<1||count>128){setError("Количество символов: от 1 до 128");setMinChars(String(latest.current.minChars));return;}if(count!==latest.current.minChars)void patch({minChars:count});}}/>
    </div>
    <div className="suggestions-settings__description">
    <div className="settings__option suggestions-settings__inline"><label className="settings__option-label" htmlFor="suggestions-trigger">Текстовый триггер</label>
      <input id="suggestions-trigger" type="text" value={trigger} maxLength={8} placeholder="/ или @ или /+/" spellCheck={false} disabled={saving||isMac}
        onChange={e=>setTrigger(e.target.value)} onBlur={()=>{if(trigger!==latest.current.trigger)void patch({trigger});}}/>
    </div>
    <p className="settings__screenshot-muted">До 8 знаков без букв, цифр и пробелов.</p>
    </div>
    <CaptureActionHotkeyField label="Включение и отключение подсказок" value={cfg.toggleHotkey} disabled={saving||isMac} onSave={value=>patch({toggleHotkey:value})}/>
    <div className="settings__option settings__option--stack"><label className="settings__option-label" htmlFor="suggestions-excluded">Приложения без подсказок</label>
      <textarea id="suggestions-excluded" value={excluded} placeholder={'game.exe\neditor.exe'} spellCheck={false} disabled={saving||isMac} onChange={e=>setExcluded(e.target.value)}
        onBlur={()=>{const excludedApps=[...new Set(excluded.split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean))];if(JSON.stringify(excludedApps)!==JSON.stringify(latest.current.excludedApps))void patch({excludedApps});}}/>
      <p className="settings__screenshot-muted">Имена программ, каждое с новой строки. В полях паролей подсказки отключены. Подсказки показываются у каретки или по центру экрана.</p>
    </div>
    </div>:null}
    {error?<p className="suggestions-settings__error" role="alert">{error}</p>:null}{status?<p className="settings__screenshot-muted" role="status">{status}</p>:null}
  </div>;
}
