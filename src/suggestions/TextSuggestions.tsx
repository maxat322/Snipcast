import {useEffect,useLayoutEffect,useRef,useState,type FormEvent,type KeyboardEvent} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import type {TextSuggestionsView} from "../types";
import {applyUiThemeSetting,normalizeUiTheme} from "../uiTheme";
import {applyBracketReplacements,extractOrderedBracketLabels} from "../bracketPlaceholders";
import {extractFileLinkRefs,stripFileLinkPlaceholders} from "../fileLinkPlaceholders";
import "./suggestions.css";

const EMPTY:TextSuggestionsView={session:0,query:"",hits:[],selected:0,theme:"dark",placement:"center"};
export function TextSuggestions(){
  const [view,setView]=useState(EMPTY),latest=useRef(0),theme=useRef("dark");
  const [values,setValues]=useState<Record<string,string>>({}),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const busyRef=useRef(false),formRef=useRef<HTMLFormElement>(null),enterIntent=useRef<{clipboard:boolean}|null>(null);
  const [page,setPage]=useState(0);
  const pending=view.form;
  const body=pending?stripFileLinkPlaceholders(pending.text):"";
  const labels=extractOrderedBracketLabels(body),files=pending?extractFileLinkRefs(pending.text):[];
  const pageSize=Math.max(1,Math.min(6,pending?.pageSize??6)),pages=Math.max(1,Math.ceil(labels.length/pageSize));
  const visibleLabels=labels.slice(page*pageSize,(page+1)*pageSize);
  useEffect(()=>{
    let live=true,unlisten:(()=>void)|undefined;
    const accept=(next:TextSuggestionsView|null)=>{if(!live||!next||next.session<latest.current)return;latest.current=next.session;theme.current=next.theme;applyUiThemeSetting(normalizeUiTheme(next.theme));setView(next);};
    void listen<TextSuggestionsView>("snipcast://suggestions-view",e=>accept(e.payload)).then(async fn=>{if(!live){fn();return;}unlisten=fn;accept(await invoke<TextSuggestionsView>("snipcast_suggestions_view"));}).catch(()=>{});
    const mq=matchMedia("(prefers-color-scheme: dark)");const changed=()=>applyUiThemeSetting(normalizeUiTheme(theme.current));mq.addEventListener("change",changed);
    return()=>{live=false;unlisten?.();mq.removeEventListener("change",changed);};
  },[]);
  useEffect(()=>{
    if(!view.hits.length||pending)return;
    let frame=0;const first=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>{void invoke("snipcast_suggestions_action",{session:view.session,action:"ready"}).catch(()=>{});});});
    return()=>{cancelAnimationFrame(first);cancelAnimationFrame(frame);};
  },[view,pending]);
  useLayoutEffect(()=>{
    if(!pending)return;
    setValues({});setError("");setPage(0);enterIntent.current=null;
    const focus=()=>{if(!formRef.current?.contains(document.activeElement))formRef.current?.querySelector<HTMLElement>("input,button[type=submit]")?.focus();};
    const frame=requestAnimationFrame(()=>{focus();void invoke("snipcast_suggestions_action",{session:pending.session,action:"form-ready"}).catch(e=>setError(String(e)));});
    const blur=()=>{enterIntent.current=null;};
    window.addEventListener("focus",focus);window.addEventListener("blur",blur);
    return()=>{cancelAnimationFrame(frame);window.removeEventListener("focus",focus);window.removeEventListener("blur",blur);};
  },[pending?.session]);
  useLayoutEffect(()=>{
    if(!pending||!formRef.current)return;
    let lastHeight=0;
    const measure=()=>{
      const form=formRef.current;if(!form)return;
      const panel=form.closest(".text-suggestions");if(!panel)return;
      const fields=form.querySelector<HTMLElement>(".text-suggestions__fields");
      const actions=form.querySelector<HTMLElement>(".text-suggestions__form-actions");
      const paging=form.querySelector<HTMLElement>(".text-suggestions__pages");
      const height=Math.ceil((panel.querySelector("header")?.getBoundingClientRect().height??0)+(panel.querySelector("footer")?.getBoundingClientRect().height??0)+(fields?.scrollHeight??0)+(actions?.getBoundingClientRect().height??0)+(paging?.getBoundingClientRect().height??0)+2);
      if(height!==lastHeight){lastHeight=height;void invoke("snipcast_suggestions_action",{session:pending.session,action:"form-size",index:height}).catch(()=>{});}
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(formRef.current.querySelector(".text-suggestions__fields")!);
    return()=>observer.disconnect();
  },[pending?.session,page,error]);
  const action=(name:string,index?:number)=>void invoke("snipcast_suggestions_action",{session:pending?.session??view.session,action:name,index}).catch(()=>{});
  const complete=async(fromClipboard=false)=>{
    if(!pending||busyRef.current)return;
    busyRef.current=true;setBusy(true);setError("");
    try {
      const resolved={...values};
      for(const input of formRef.current?.querySelectorAll<HTMLInputElement>("[data-bracket-label]")??[]){
        const label=input.dataset.bracketLabel;if(label)resolved[label]=input.value;
      }
      if(fromClipboard&&document.activeElement instanceof HTMLInputElement){
        const label=document.activeElement.dataset.bracketLabel;
        if(label){resolved[label]=await invoke<string>("snipcast_clipboard_read_text");setValues(resolved);}
      }
      await invoke("snipcast_suggestions_complete",{session:pending.session,text:applyBracketReplacements(body,labels,resolved).trim(),fileRefs:files});
    } catch(e){setError(String(e));}
    finally{busyRef.current=false;setBusy(false);}
  };
  const submit=(e:FormEvent)=>{e.preventDefault();void complete();};
  const keys=(e:KeyboardEvent)=>{
    if(e.nativeEvent.isComposing)return;
    if(e.key==="Escape"){e.preventDefault();e.stopPropagation();enterIntent.current=null;if(!busyRef.current)action("cancel-pending");}
    else if(e.key==="Enter"){
      if(e.target instanceof HTMLButtonElement&&e.target.type==="button")return;
      e.preventDefault();e.stopPropagation();
      if(!e.repeat&&!busyRef.current)enterIntent.current={clipboard:e.ctrlKey||e.metaKey};
    }
  };
  const keyUp=(e:KeyboardEvent)=>{
    if(e.key!=="Enter"||!enterIntent.current)return;
    e.preventDefault();e.stopPropagation();const intent=enterIntent.current;enterIntent.current=null;
    if(!e.nativeEvent.isComposing)void complete(intent.clipboard);
  };
  return <section className={`text-suggestions${pending?" text-suggestions--form":""}`} aria-label="Быстрая палитра" data-session={view.session} data-placement={view.placement}>
    <header><span>{pending?"Поля шаблона":"Шаблоны"}</span><span className="text-suggestions__query">{pending?.title??view.query}</span><button type="button" aria-label="Закрыть быструю палитру" disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>action(pending?"cancel-pending":"dismiss")}>×</button></header>
    {pending?<form ref={formRef} className="text-suggestions__form" aria-label="Поля шаблона" onSubmit={submit} onKeyDown={keys} onKeyUp={keyUp}>
      <div className="text-suggestions__fields">
        {visibleLabels.map((label,i)=><label key={label} title={label}><span className="text-suggestions__field-label">{label}</span><input autoFocus={i===0} data-bracket-label={label} value={values[label]??""} onChange={e=>setValues(prev=>({...prev,[label]:e.target.value}))} autoComplete="off" spellCheck={false} disabled={busy}/></label>)}
        {files.length?<p className="text-suggestions__attachments">Вложения: {files.map(file=>file.split(/[\\/]/).pop()).join(", ")}</p>:null}
        {error?<p role="alert" title={error} className="suggestions-settings__error">{error}</p>:null}
      </div>
      {pages>1?<div className="text-suggestions__pages"><button type="button" aria-label="Предыдущие поля" disabled={busy||page===0} onClick={()=>setPage(p=>p-1)}>←</button><span>Поля {page*pageSize+1}–{Math.min((page+1)*pageSize,labels.length)} из {labels.length}</span><button type="button" aria-label="Следующие поля" disabled={busy||page>=pages-1} onClick={()=>setPage(p=>p+1)}>→</button></div>:null}
      <div className="text-suggestions__form-actions"><button type="button" disabled={busy} onClick={()=>action("cancel-pending")}>Отмена</button><button type="submit" autoFocus={!labels.length} disabled={busy}>{busy?"Вставка…":"Вставить"}</button></div>
    </form>:<div role="listbox" aria-label="Найденные шаблоны" aria-activedescendant={view.hits.length?`suggestion-${view.selected}`:undefined}>
      {view.hits.map((hit,i)=><button type="button" role="option" id={`suggestion-${i}`} aria-selected={i===view.selected} key={hit.id} className={i===view.selected?"is-selected":""}
        onMouseDown={e=>e.preventDefault()} onClick={()=>action("choose",i)} title={[hit.path,hit.preview].filter(Boolean).join("\n")}>
        <span className="text-suggestions__title">{hit.title||"Без названия"}</span><span className="text-suggestions__preview">{hit.preview}</span>
      </button>)}
    </div>}
    <footer>{pending?<><span><kbd>Enter</kbd> вставить</span><span><kbd>Esc</kbd> отменить</span></>:<><span><kbd>↑</kbd><kbd>↓</kbd> выбор</span><span><kbd>Enter</kbd> вставить</span><span><kbd>Esc</kbd> закрыть</span></>}</footer>
  </section>;
}
