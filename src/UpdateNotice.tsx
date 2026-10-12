import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import type {AppConfig,UpdateInfo} from "./types";
import {normalizeUiTheme,resolveUiTheme} from "./uiTheme";
import "./update-notice.css";

const stages:Record<string,string>={check:"Проверка версии…",download:"Загрузка…",verify:"Проверка файла…",install:"Установка…",restart:"Перезапуск…"};
export function UpdateNotice(){
  const [info,setInfo]=useState<UpdateInfo|null>(null),[theme,setTheme]=useState("dark");
  const [busy,setBusy]=useState(false),[stage,setStage]=useState(""),[error,setError]=useState("");
  useEffect(()=>{
    let dead=false;
    const refresh=()=>{
      void invoke<AppConfig>("snipcast_get_config").then(c=>{if(!dead)setTheme(resolveUiTheme(normalizeUiTheme(c.theme)));}).catch(()=>{});
      return invoke<UpdateInfo|null>("snipcast_update_notice_info").then(i=>{if(!dead)setInfo(i);}).catch(e=>{if(!dead)setError(String(e));});
    };
    const update=listen("snipcast://update-notice",()=>{void refresh();});
    const progress=listen<string>("snipcast://update-stage",e=>{if(!dead)setStage(e.payload);});
    void refresh();
    return ()=>{dead=true;void update.then(f=>f());void progress.then(f=>f());};
  },[]);
  const action=async(kind:"install"|"skip"|"dismiss")=>{
    if(busy)return;setBusy(true);setError("");
    try{
      if(kind==="install")await invoke("snipcast_install_update",{expectedVersion:info?.latestVersion});
      else if(kind==="skip")await invoke("snipcast_skip_update",{version:info?.latestVersion});
      else await invoke("snipcast_dismiss_update");
    }catch(e){setError(String(e));if(kind==="install")setInfo(await invoke<UpdateInfo|null>("snipcast_update_notice_info").catch(()=>null));}
    finally{setBusy(false);}
  };
  return <main className="update-notice" data-theme={theme}>
    <header data-tauri-drag-region><span>Обновление Snipcast</span><button aria-label="Закрыть" disabled={busy} onClick={()=>void action("dismiss")}>×</button></header>
    <h1>Доступна версия {info?.latestVersion??"…"}</h1>
    <p className="update-notice__version">Установлена {info?.currentVersion??"…"}</p>
    <section className="update-notice__notes" aria-label="Список изменений">
      <pre>{info?.notes||"Описание изменений отсутствует."}</pre>
    </section>
    {error?<p role="alert" className="update-notice__error">{error}</p>:null}
    {busy?<p role="status">{stages[stage]??"Пожалуйста, подождите…"}</p>:null}
    <footer><button disabled={busy||!info} onClick={()=>void action("skip")}>Пропустить версию</button>
      <button className="update-notice__primary" disabled={busy||!info?.available} onClick={()=>void action("install")}>{busy?"Обновление…":"Обновить"}</button></footer>
  </main>;
}
