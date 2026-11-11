import {PaletteFrame,PaletteChrome,PaletteSearch,PaletteHints,PaletteItemText,PaletteCalculation,PaletteBackButton} from '../components/PaletteFrame';
import {memo,useEffect,useLayoutEffect,useRef,useState,useMemo} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {save,confirm} from '@tauri-apps/plugin-dialog';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {applyUiThemeSetting,applyPaletteListDensity} from '../uiTheme';
import type {AppConfig} from '../types';
import {type Catalog,type Clip,defaults,search,calculate,commandEnabled,clipboardKindIcons,guessSource,languageOptions,preferredTarget,visibleCommandIds} from './model';
import emojis from './emoji.json';
import {EmojiGrid} from './EmojiGrid';
import {ThemedSelect} from '../components/ThemedSelect';
import {useClipboardHistory,withDeadline} from './useClipboardHistory';
import {ClipboardHistoryList} from './ClipboardHistoryList';
const emojiIndex=emojis.map(e=>({...e,searchText:`${e.name} ${e.keywords} ${e.emoji}`.toLowerCase()}));
type OpenRequest={id:number;section:string};
import '../App.css';
import '../theme-overrides.css';
import './commands.css';
const names:Record<string,string>={root:'Палитра шаблонов',clipboard:'Буфер обмена',emoji:'Emoji',translate:'Переводчик',calculator:'Калькулятор'};
const kinds:Record<string,string>={text:'Текст',image:'Изображения',files:'Файлы',link:'Ссылки',email:'Email',color:'Цвета'};
const categoryIcons:Record<string,string>={'':'▦','recent':'◷','Smileys & Emotion':'😀','People & Body':'👋','Animals & Nature':'🐾','Food & Drink':'🍴','Travel & Places':'✈','Activities':'⚽','Objects':'💡','Symbols':'♥','Flags':'⚑'};
const categories:Record<string,string>={'Smileys & Emotion':'Смайлы и эмоции','People & Body':'Люди','Animals & Nature':'Животные и природа','Food & Drink':'Еда и напитки','Travel & Places':'Путешествия','Activities':'Занятия','Objects':'Предметы','Symbols':'Символы','Flags':'Флаги'};
const TRANSLATE_PAUSE_MS=500;
type TranslationMemory={input:string;output:string;source:string;target:string;at:number};
export function CommandsApp({embeddedSection,onBack}:{embeddedSection?:string;onBack?:()=>void}={}){
 const [catalog,setCatalog]=useState<Catalog>({entries:[],config:defaults,section:'root',scanning:false,error:''}),[section,setSection]=useState(embeddedSection??'root'),[group,setGroup]=useState('all'),[hover,setHover]=useState<number|null>(null),[openEpoch,setOpenEpoch]=useState(0),[query,setQuery]=useState(''),[selected,setSelected]=useState(0),[error,setError]=useState(''),[menu,setMenu]=useState(false),[actionQuery,setActionQuery]=useState(''),[filter,setFilter]=useState(''),[detail,setDetail]=useState<Clip|null>(null),[busy,setBusy]=useState(false),[rename,setRename]=useState<string|null>(null),[translation,setTranslation]=useState(''),[input,setInput]=useState(''),[source,setSource]=useState('en'),[target,setTarget]=useState('ru'),[selection,setSelection]=useState<number[]>([]),[memories,setMemories]=useState<TranslationMemory[]>([]),[historyAt,setHistoryAt]=useState<number|null>(null);
 const searchRef=useRef<HTMLInputElement>(null),version=useRef(0),latestOpen=useRef(0),openingVersion=useRef(0),[pendingOpen,setPendingOpen]=useState<number|null>(null),[direct,setDirect]=useState(false),dialogOpen=useRef(false),anchorId=useRef<number|null>(null),editedRef=useRef(false),skipTranslate=useRef(false),liveRef=useRef({input:'',translation:''});const cfg=catalog.config;
 const run=async(fn:()=>Promise<unknown>)=>{setError('');try{return await fn()}catch(e){setError(String(e))}};
 const load=async()=>{const c=await invoke<Catalog>('snipcast_commands_catalog');setCatalog(c);const a=await invoke<AppConfig>('snipcast_get_config');applyUiThemeSetting(a.theme);applyPaletteListDensity(a.paletteListDensity);if(c.error)setError(c.error);return c};
 const open=(s:string,request?:OpenRequest)=>{openingVersion.current++;setPendingOpen(request?.id??null);setDirect(!!request&&s!=='root');setDetail(null);setSection(s||'root');setOpenEpoch(n=>n+1);setRename(null);if(!request&&!embeddedSection)void invoke('snipcast_commands_section',{section:s||'root'}).catch(()=>{});setQuery('');setFilter('');setGroup('all');setSelected(0);selectionRef.current=[];setSelection([]);anchorId.current=null;setMenu(false);setError('');if(s==='translate'){version.current++;editedRef.current=false;setInput('');setTranslation('');setBusy(false);setHistoryAt(null);}};
 const focusInput=()=>{if(menu||rename!==null)return;if(section==='translate')document.querySelector<HTMLTextAreaElement>('.commands__translator textarea')?.focus();else searchRef.current?.focus()};
 const focusRef=useRef(focusInput);focusRef.current=focusInput;
 useLayoutEffect(focusInput,[section,menu,rename,openEpoch]);
 useEffect(()=>{let timer:ReturnType<typeof setTimeout>|undefined;const win=getCurrentWindow();const off=win.onFocusChanged(e=>{if(timer)clearTimeout(timer);if(e.payload)requestAnimationFrame(()=>focusRef.current());else if(!dialogOpen.current)timer=setTimeout(()=>{if(!dialogOpen.current)void win.isFocused().then(focused=>{if(!focused&&!dialogOpen.current)void invoke('snipcast_palette_blur')})},200)});return()=>{if(timer)clearTimeout(timer);void off.then(f=>f())}},[embeddedSection]);
 const {clips,total,loading:historyLoading,error:historyError,refresh:refreshClips}=useClipboardHistory(section==='clipboard',query,filter,openEpoch);
 const totalRef=useRef(total),refreshRef=useRef(refreshClips);totalRef.current=total;refreshRef.current=refreshClips;
 useLayoutEffect(()=>{if(pendingOpen!==null)void invoke('snipcast_commands_ready',{id:pendingOpen}).catch(e=>setError(String(e)))},[pendingOpen,openEpoch]);
 useEffect(()=>{
  let disposed=false;
  const accept=(request:OpenRequest|string)=>{
   if(disposed)return;
   if(typeof request==='string'){open(request);return;}
   if(request.id<=latestOpen.current)return;
   latestOpen.current=request.id;open(request.section,request);
  };
  const initialVersion=openingVersion.current;
  const stops=[...(!embeddedSection?[listen<OpenRequest|string>('snipcast://commands-open',e=>{accept(e.payload);void run(load)})]:[]),listen('snipcast://commands-catalog',()=>void run(load)),listen<string>('snipcast://commands-error',e=>setError(e.payload))];
  void run(async()=>{
   await Promise.all(stops);
   const c=await load();if(disposed)return;
   // A slow startup response must not replace a more recent hotkey request.
   if(embeddedSection)open(embeddedSection);else if(c.pending)accept(c.pending);else if(openingVersion.current===initialVersion)open(c.section);
   setSource(c.config.sourceLanguage);setTarget(c.config.targetLanguage);
  });
  return()=>{disposed=true;stops.forEach(p=>void p.then(f=>f()))};
 },[]);
 const results=useMemo(()=>search(catalog.entries,query,cfg).filter(e=>(e.kind!=='command'||visibleCommandIds.has(e.id))&&(query.trim()||e.kind!=='application')&&(group==='all'||e.kind===group)),[catalog,query,group]);const calc=(section==='root'||section==='calculator')&&commandEnabled(cfg,'calculator')?calculate(query):null;
 useEffect(()=>{if(section!=='root'&&!commandEnabled(cfg,section)){if(embeddedSection)onBack?.();else void run(hide)}},[cfg,section,embeddedSection,onBack]);
 const emojiData=useMemo(()=>{const q=query.toLowerCase();const recent=Object.fromEntries(Object.entries(catalog.usage??{}).map(([id,value])=>[id,value[0]]));const ranked=emojiIndex.filter(e=>(recent['emoji:'+e.emoji]??0)>0).sort((a,b)=>(recent['emoji:'+b.emoji]??0)-(recent['emoji:'+a.emoji]??0)).slice(0,21);if(!filter&&!q)return {items:[...ranked,...emojiIndex],popularCount:ranked.length,grouped:true};const top=new Set(ranked.map(e=>e.emoji));const ordered=[...ranked,...emojiIndex.filter(e=>!top.has(e.emoji))];return {items:ordered.filter(e=>(!filter||filter===e.category||filter==='recent'&&top.has(e.emoji))&&(!q||e.searchText.includes(q))),popularCount:0,grouped:false}},[query,filter,catalog.usage]);const emojiList=emojiData.items;
 const emojiVertical=(index:number,direction:number)=>{const split=emojiData.popularCount;if(!emojiData.grouped||!split)return Math.max(0,Math.min(emojiList.length-1,index+direction*cfg.emojiColumns));const start=index<split?0:split,end=index<split?split:emojiList.length;const col=(index-start)%cfg.emojiColumns,next=index+direction*cfg.emojiColumns;if(next>=start&&next<end)return next;if(direction>0&&end===split)return Math.min(emojiList.length-1,split+col);if(direction<0&&start===split){const lastRow=Math.floor((split-1)/cfg.emojiColumns)*cfg.emojiColumns;return Math.min(split-1,lastRow+col)}return index};
 const count=section==='clipboard'?clips.length:section==='emoji'?emojiList.length:results.length+(calc?.result?1:0);
 useEffect(()=>{cursorRef.current=0;shiftActive.current=false;selectionRef.current=[];setSelected(0);setSelection([]);anchorId.current=null},[query,filter,section]);useEffect(()=>{const last=Math.max(0,count-1);cursorRef.current=Math.min(cursorRef.current,last);setSelected(n=>Math.min(n,last))},[count]);useEffect(()=>{setSelection(current=>{const valid=current.filter(id=>clips.some(c=>c.id===id));selectionRef.current=valid;return valid.length===current.length?current:valid})},[clips]);
 // Детали записи грузим только после паузы в навигации: удержание стрелки не
 // должно ставить в очередь запрос на каждое повторение клавиши (для картинок
 // это чтение и base64-кодирование файла), иначе список «доезжает» после
 // отпускания. Кэш по id делает возврат к записи мгновенным.
 const detailCache=useRef<Map<number,Clip>>(new Map()),detailSeq=useRef(0),clipsSnapshot=useRef(clips);
 // Навигация стрелками коалесцируется в один кадр, а detail грузится только
 // после отпускания клавиши: удержание не ставит в очередь запросы и рендеры.
 // Шаги делают только нажатие и свежие автоповторы Windows (их задержка и
 // частота — из настроек клавиатуры). Собственного таймера нет: если keyup
 // опоздал или потерялся, список не продолжает ехать сам.
 const navHeld=useRef(false),navFrame=useRef(0),navMode=useRef<'nav'|'shift'>('nav'),heldKey=useRef<string|null>(null),lastRepeat=useRef(0),navWatchdog=useRef(0),shiftActive=useRef(false),cursorRef=useRef(0),selectionRef=useRef<number[]>([]),clipsRef=useRef(clips),selectRef=useRef<(index:number)=>void>(()=>{}),extendRef=useRef<(index:number)=>void>(()=>{});
 const [navIdle,setNavIdle]=useState(0);
 const releaseNav=()=>{heldKey.current=null;window.clearTimeout(navWatchdog.current);navWatchdog.current=0;if(navHeld.current){navHeld.current=false;setNavIdle(n=>n+1)}};
 useEffect(()=>{releaseNav();if(navFrame.current)cancelAnimationFrame(navFrame.current);navFrame.current=0;shiftActive.current=false;cursorRef.current=0},[section]);
 // Дозагрузка страницы не сбрасывает кэш деталей: старые объекты остаются теми же.
 useEffect(()=>{const previous=clipsSnapshot.current;if(previous!==clips){clipsSnapshot.current=clips;if(!previous.every((c,i)=>clips[i]===c))detailCache.current.clear()}},[clips]);
 useEffect(()=>{
  const seq=++detailSeq.current;
  if(section!=='clipboard'){setDetail(null);return}
  if(navHeld.current)return;
  const id=clips[selected]?.id;
  if(!id){setDetail(null);return}
  const cached=detailCache.current.get(id);
  if(cached){setDetail(cached);return}
  // Первая запись после открытия раздела грузится сразу, остальные — после
  // короткой паузы, чтобы удержание стрелки не копило запросы.
  const timer=setTimeout(()=>{void run(async()=>{try{const c=await withDeadline(invoke<Clip>('snipcast_history_detail',{id}));if(seq!==detailSeq.current)return;detailCache.current.set(id,c);if(!navHeld.current)setDetail(c)}catch(e){if(seq===detailSeq.current)setError(String(e))}})},detail?120:0);
  return()=>clearTimeout(timer);
 },[section,clips,selected,navIdle]);
 useEffect(()=>{if(section!=='emoji'&&section!=='clipboard')document.querySelector('[data-selected="true"]')?.scrollIntoView({block:'nearest'})},[selected,section]);
 const hide=()=>invoke(embeddedSection?'palette_hide':'snipcast_commands_hide');
 const back=()=>{if(onBack)onBack();else open('root')};
 const write=(text:string,paste:boolean,usageId?:string)=>invoke('snipcast_commands_text',{text,paste,usageId});
 const clipAction=async(action:string,value?:string)=>{const id=clips[cursorRef.current]?.id??0;if(!id&&!['delete-all','delete-recent'].includes(action))return;if(['delete-all','delete-recent'].includes(action)){dialogOpen.current=true;try{if(!await confirm('Удалить записи, включая закреплённые? Это действие нельзя отменить.',{title:'Очистить историю',kind:'warning'}))return}finally{dialogOpen.current=false}}if(action==='save'){dialogOpen.current=true;let path;try{path=await save({defaultPath:detail?.kind==='image'?'clipboard.png':'clipboard.txt',filters:[{name:detail?.kind==='image'?'PNG':'Текст',extensions:[detail?.kind==='image'?'png':'txt']}]})}finally{dialogOpen.current=false}if(!path)return;value=path;}await invoke('snipcast_history_action',{id,action,value});if(['paste','plain'].includes(action))return;await refreshClips();};
 // Shift выделяет непрерывный диапазон от опорной записи. Порядок вставки
 // обратный направлению выделения: последняя выделенная запись вставляется первой.
 const clampCursor=(index:number)=>Math.max(0,Math.min((clipsRef.current.length||1)-1,index));
 const selectOnly=(index:number)=>{shiftActive.current=false;const i=clampCursor(index);const c=clipsRef.current[i];cursorRef.current=i;setSelected(i);anchorId.current=c?.id??null;const ids=c?[c.id]:[];selectionRef.current=ids;setSelection(ids)};
 const extendTo=(index:number)=>{const list=clipsRef.current;if(!list.length)return;const target=clampCursor(index);const from=anchorId.current===null?-1:list.findIndex(c=>c.id===anchorId.current);const start=from>=0?from:clampCursor(cursorRef.current);if(anchorId.current===null)anchorId.current=list[start]?.id??null;const ordered=list.slice(Math.min(start,target),Math.max(start,target)+1).map(c=>c.id);if(target<start)ordered.reverse();cursorRef.current=target;selectionRef.current=ordered;setSelection(ordered);setSelected(target)};
 clipsRef.current=clips;selectRef.current=selectOnly;extendRef.current=extendTo;
 const selectRow=(index:number,additive:boolean)=>{if(!additive){selectOnly(index);return}if(!shiftActive.current){shiftActive.current=true;anchorId.current=clipsRef.current[cursorRef.current]?.id??null;}cursorRef.current=clampCursor(index);extendTo(index)};
 // Рендер списка не чаще кадра. Следующая страница истории запрашивается
 // заранее, чтобы удержание стрелки не упиралось в конец загруженной части.
 const NAV_PREFETCH=40;
 const holdNav=()=>{navHeld.current=true;window.clearTimeout(navWatchdog.current);navWatchdog.current=window.setTimeout(()=>{navWatchdog.current=0;if(navHeld.current){navHeld.current=false;setNavIdle(n=>n+1)}},1100)};
 const prefetchNav=(index:number)=>{const loaded=clipsRef.current.length;if(index>=loaded-NAV_PREFETCH&&loaded<totalRef.current)void refreshRef.current(true)};
 const scheduleNav=(delta:number)=>{holdNav();if(navFrame.current&&navMode.current!=='nav'){cancelAnimationFrame(navFrame.current);navFrame.current=0}navMode.current='nav';shiftActive.current=false;const next=clampCursor(cursorRef.current+delta);cursorRef.current=next;prefetchNav(next);if(navFrame.current)return;navFrame.current=requestAnimationFrame(()=>{navFrame.current=0;selectRef.current(cursorRef.current)})};
 const scheduleShiftNav=(delta:number)=>{holdNav();if(navFrame.current&&navMode.current!=='shift'){cancelAnimationFrame(navFrame.current);navFrame.current=0}navMode.current='shift';if(!shiftActive.current){shiftActive.current=true;anchorId.current=clipsRef.current[cursorRef.current]?.id??null}const next=clampCursor(cursorRef.current+delta);cursorRef.current=next;prefetchNav(next);if(navFrame.current)return;navFrame.current=requestAnimationFrame(()=>{navFrame.current=0;extendRef.current(cursorRef.current)})};
 // Нажатие — ровно один шаг. Автоповтор — шаг, только если он свежий:
 // события, пролежавшие в очереди ввода (занятое окно), приходят пачкой или
 // со старой отметкой времени и отбрасываются, поэтому после отпускания
 // клавиши выделение не «доезжает».
 const NAV_STALE_MS=120,NAV_BURST_MS=12;
 const acceptNavKey=(e:KeyboardEvent)=>{const now=performance.now();if(!e.repeat){heldKey.current=e.key;lastRepeat.current=now;return true}if(heldKey.current!==e.key)return false;const lag=now-e.timeStamp;if(e.timeStamp>0&&lag>NAV_STALE_MS)return false;if(now-lastRepeat.current<NAV_BURST_MS)return false;lastRepeat.current=now;return true};
 const flushNav=()=>{if(!navFrame.current)return;cancelAnimationFrame(navFrame.current);navFrame.current=0;if(navMode.current==='shift')extendRef.current(cursorRef.current);else selectRef.current(cursorRef.current)};
 const pasteSelected=async()=>{const chosen=selectionRef.current;if(chosen.length>1){const ids=[...chosen].reverse();const result=await invoke('snipcast_history_paste_many',{ids});selectionRef.current=[];shiftActive.current=false;setSelection([]);anchorId.current=null;return result}return clipAction('paste')};
 const emojiValue=()=>{const e=emojiList[selected];if(!e)return '';return e.emoji+(e.tone?cfg.skinTone:'')};
 const primary=async(copy=false)=>{if(section==='clipboard')return copy?clipAction('copy'):pasteSelected();if(section==='emoji'){const text=emojiValue();if(text){await write(text,!copy&&cfg.emojiAction==='paste','emoji:'+emojiList[selected].emoji);if(copy||cfg.emojiAction==='copy')await hide();}return}if(section==='translate'){if(translation)await write(translation,false);return}if(calc?.result&&selected===0){await write(calc.result,false);await hide();return}const item=results[selected-(calc?.result?1:0)];if(item){if(['clipboard','emoji','translate','calculator'].includes(item.id))open(item.id);else await invoke('snipcast_commands_run',{id:item.id});}};
 const noteUsage=async(sourceCode:string,targetCode:string)=>{const a=await invoke<AppConfig>('snipcast_get_config');const base=a.commands??defaults;const usage={...(base.languageUsage??{})};if(sourceCode&&sourceCode!=='auto')usage[`source:${sourceCode}`]=(usage[`source:${sourceCode}`]??0)+1;if(targetCode&&targetCode!=='auto')usage[`target:${targetCode}`]=(usage[`target:${targetCode}`]??0)+1;const commands={...base,languageUsage:usage};await invoke('snipcast_save_config',{incoming:{...a,commands}});setCatalog(c=>({...c,config:{...c.config,languageUsage:usage}}))};
 const rememberLanguages=async(s:string,t:string)=>{setHistoryAt(null);setSource(s);setTarget(t);const a=await invoke<AppConfig>('snipcast_get_config');const base=a.commands??defaults;const usage={...(base.languageUsage??{})};if(s!=='auto')usage[`source:${s}`]=(usage[`source:${s}`]??0)+1;if(t!=='auto')usage[`target:${t}`]=(usage[`target:${t}`]??0)+1;const commands={...base,sourceLanguage:s,targetLanguage:t,languageUsage:usage};await invoke('snipcast_save_config',{incoming:{...a,commands}});setCatalog(c=>({...c,config:{...c.config,...commands}}))};
 useEffect(()=>{if(section!=='translate')return;let cancel=false;void invoke<string|null>('snipcast_history_latest_text').then(text=>{if(cancel||editedRef.current||!text)return;setInput(text)}).catch(()=>{});return()=>{cancel=true}},[section,openEpoch]);
 useEffect(()=>{if(section!=='translate')return;let cancel=false;void invoke<TranslationMemory[]|null>('snipcast_translation_history').then(items=>{if(!cancel&&Array.isArray(items))setMemories(items)}).catch(()=>{});return()=>{cancel=true}},[section,openEpoch]);
 useEffect(()=>{
  if(section!=='translate')return;
  if(skipTranslate.current){skipTranslate.current=false;version.current++;return}
  if(historyAt!==null){version.current++;return}
  const text=input;const v=++version.current;
  if(!text.trim()){setBusy(false);setTranslation('');return}
  setTranslation('');setBusy(false);
  const requestedSource=source;const requestedTarget=target==='auto'?preferredTarget(cfg.languageUsage??{},cfg.targetLanguage):target;
  const timer=window.setTimeout(()=>{
   if(v!==version.current)return;
   setBusy(true);
   void (async()=>{try{await run(async()=>{
    const translated=await invoke<string>('snipcast_commands_translate',{text,source:requestedSource,target:requestedTarget});
    if(v!==version.current)return;
    const usedSource=requestedSource==='auto'?guessSource(text):requestedSource;
    const remembered=await invoke<TranslationMemory[]|null>('snipcast_translation_remember',{input:text,output:translated,source:usedSource,target:requestedTarget});
    if(v!==version.current)return;
    if(Array.isArray(remembered))setMemories(remembered);
    setTranslation(translated);
    void noteUsage(usedSource,requestedTarget).catch(()=>{});
   })}finally{if(v===version.current)setBusy(false)}})()},TRANSLATE_PAUSE_MS);
  return()=>clearTimeout(timer);
 },[section,input,source,target,historyAt]);
 const canPrimary=section==='clipboard'?!!clips[selected]:section==='emoji'?!!emojiList[selected]:section==='translate'?!!translation:!!(calc?.result&&selected===0||results[selected-(calc?.result?1:0)]);
 const primaryLabel=section==='translate'?'Копировать перевод':section==='clipboard'?(selection.length>1?`Вставить (${selection.length})`:'Вставить'):(section==='root'||section==='calculator')?(calc?.result&&selected===0?'Копировать':'Открыть'):section==='emoji'&&cfg.emojiAction==='copy'?'Копировать':'Вставить';
 const actions=section==='clipboard'?[['Вставить','paste'],['Копировать','copy'],['Вставить и оставить окно','paste-keep'],...(detail?.text?[['Вставить обычным текстом','plain']]:[]),[detail?.pinned?'Открепить':'Закрепить','pin'],['Переименовать','rename'],...(detail?.kind!=='files'?[['Сохранить в файл…','save']]:[]),...(detail?.kind==='image'?[['Распознать и скопировать текст','ocr']]:[]),['Удалить запись','delete'],['Удалить за последний час…','delete-recent'],['Удалить всю историю…','delete-all']]:[['Выполнить','primary'],...((section==='emoji'||section==='translate'||calc?.result&&selected===0)?[['Копировать','copy']]:[]),...(calc?.result?[['Вставить результат','calc-paste']]:[]),['Настройки команд','settings']];
 // Like the ordinary palette, listen on the window: clicking a non-focusable
 // preview or removing a focused control leaves keyboard events on document.body.
 const stepHistory=(dir:1|-1)=>{
  if(dir<0){if(!memories.length)return;const next=historyAt===null?0:Math.min(memories.length-1,historyAt+1);if(historyAt!==null&&next===historyAt)return;const item=memories[next];if(!item)return;version.current++;if(historyAt===null)liveRef.current={input,translation};setHistoryAt(next);setInput(item.input);setTranslation(item.output);setBusy(false);return}
  if(historyAt===null)return;const item=historyAt===0?null:memories[historyAt-1];version.current++;if(historyAt===0){skipTranslate.current=true;setHistoryAt(null);setInput(liveRef.current.input);setTranslation(liveRef.current.translation);setBusy(false);return}if(!item)return;setHistoryAt(historyAt-1);setInput(item.input);setTranslation(item.output);setBusy(false);
 };
 const onKey=(e:KeyboardEvent)=>{
 if(e.isComposing)return;
 if(e.target instanceof Element&&e.target.closest('.snip-select')&&!(e.key==='Escape'&&e.target.closest('.snip-select')?.querySelector('[role=combobox]')?.getAttribute('aria-expanded')==='false'))return;
 if(e.key==='Escape'){e.preventDefault();if(rename!==null)setRename(null);else if(menu)setMenu(false);else if(section==='clipboard'&&selection.length>1&&!direct)selectOnly(selected);else if(section!=='root'&&!direct)back();else void run(hide);return}
 if((e.ctrlKey||e.metaKey)&&e.code==='KeyK'&&rename===null){e.preventDefault();void run(()=>invoke('snipcast_commands_run',{id:'command-settings'}));return}
 if(e.key==='Tab'&&section==='root'&&!menu&&e.target===searchRef.current){e.preventDefault();const groups=['all','application','command'];setGroup(groups[(groups.indexOf(group)+(e.shiftKey?2:1))%3]);setSelected(0);return}
 if((e.ctrlKey||e.metaKey)&&e.code==='KeyJ'&&rename===null){e.preventDefault();setMenu(m=>!m);setActionQuery('');return}
 if(menu){if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const buttons=Array.from(document.querySelectorAll<HTMLButtonElement>('.commands__actions button'));const at=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[at<0?(e.key==='ArrowDown'?0:buttons.length-1):(at+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Enter'&&e.target instanceof HTMLInputElement){e.preventDefault();document.querySelector<HTMLButtonElement>('.commands__actions button')?.click();}return}if(rename!==null)return;if(section==='translate'){if(e.target instanceof HTMLButtonElement&&['Enter',' '].includes(e.key))return;if(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.ctrlKey&&!e.metaKey){e.preventDefault();if(translation)void run(()=>write(translation,false));return}const plus=e.key==='+'||e.code==='NumpadAdd';const minus=(e.key==='-'||e.code==='NumpadSubtract')&&!e.shiftKey;if((plus||minus)&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();stepHistory(plus?1:-1);return}return}
 if(section==='clipboard'&&(e.key==='ArrowUp'||e.key==='ArrowDown')&&!(e.target instanceof HTMLSelectElement)){e.preventDefault();if(!acceptNavKey(e))return;const delta=e.key==='ArrowDown'?1:-1;if(e.shiftKey&&!(e.ctrlKey||e.metaKey||e.altKey))scheduleShiftNav(delta);else scheduleNav(delta);return}
 if(e.target instanceof HTMLButtonElement&&['Enter',' '].includes(e.key)&&!(e.key==='Enter'&&section==='clipboard'&&e.target.getAttribute('role')==='option'))return;
 if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(e.key)&&!(e.target instanceof HTMLSelectElement)){if(['ArrowLeft','ArrowRight'].includes(e.key)&&(section!=='emoji'||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey))return;e.preventDefault();if(section==='emoji'&&['ArrowUp','ArrowDown'].includes(e.key))setSelected(n=>emojiVertical(n,e.key==='ArrowDown'?1:-1));else setSelected(n=>Math.max(0,Math.min(count-1,n+(['ArrowDown','ArrowRight'].includes(e.key)?1:-1))))}
 if(e.key==='Enter'&&!(e.target instanceof HTMLSelectElement)){e.preventDefault();flushNav();void run(()=>primary(e.ctrlKey))}
 };
 const keyHandlerRef=useRef(onKey);keyHandlerRef.current=onKey;
 const onKeyUp=(e:KeyboardEvent)=>{if(section==='clipboard'&&(e.key==='ArrowDown'||e.key==='ArrowUp')&&(heldKey.current===null||heldKey.current===e.key))releaseNav()};
 const keyUpHandlerRef=useRef(onKeyUp);keyUpHandlerRef.current=onKeyUp;const releaseRef=useRef(releaseNav);releaseRef.current=releaseNav;
 useEffect(()=>{const handle=(e:KeyboardEvent)=>keyHandlerRef.current(e),up=(e:KeyboardEvent)=>keyUpHandlerRef.current(e);const stop=()=>releaseRef.current();window.addEventListener('keydown',handle,true);window.addEventListener('keyup',up,true);window.addEventListener('blur',stop);return()=>{window.removeEventListener('keydown',handle,true);window.removeEventListener('keyup',up,true);window.removeEventListener('blur',stop);stop()}},[]);
 return <PaletteFrame className="commands">
 <PaletteChrome><div className="commands__header">{section!=='root'&&!direct&&<PaletteBackButton onClick={back}/>}{section==='translate'?<div className="palette__search-wrap"><span className="palette__search-icon" aria-hidden>{catalog.entries.find(entry=>entry.id==='translate')?.icon||'🌐'}</span><span className="palette__search">Переводчик</span></div>:<PaletteSearch ref={searchRef} autoFocus placeholder={section==='root'?'Поиск приложений и команд…':section==='calculator'?'Введите выражение…':`Поиск — ${names[section]}`} value={query} onChange={e=>setQuery(e.target.value)} aria-label="Поиск">{section==='clipboard'&&<select aria-label="Тип записей" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">Все типы</option>{Object.entries(kinds).map(([v,n])=><option key={v} value={v}>{clipboardKindIcons[v]} {n}</option>)}</select>}{section==='emoji'&&<ThemedSelect label="Категория Emoji" value={filter} preferBelow onChange={setFilter} options={Object.entries({'':'Все категории',recent:'Часто используемые',...categories}).map(([value,label])=>({value,label,icon:<span className="commands__category-icon" aria-hidden>{categoryIcons[value]}</span>}))}/>}</PaletteSearch>}</div>{section==='root'&&<div className="palette__group-tabs" role="tablist" aria-label="Группы">{[['all','Все'],['application','Приложения'],['command','Команды']].map(([id,label])=><button key={id} role="tab" aria-selected={group===id} className={'palette__group-tab'+(group===id?' is-active':'')} onClick={()=>{setGroup(id);setSelected(0);searchRef.current?.focus()}}>{label}</button>)}</div>}</PaletteChrome>
 {(error||historyError)&&<div className="palette__empty" role="alert">{error||historyError}{historyError?<button onClick={()=>void refreshClips()}>Повторить</button>:<button onClick={()=>setError('')}>×</button>}</div>}
 <div className={'commands__body'+(section==='translate'?' commands__body--translate':'')}>
 {(section==='root'||section==='calculator')&&<div className="commands__results">{calc&&<button className={`palette__item commands__calc ${selected===0?'palette__item--kb':''}`} data-selected={selected===0} onClick={()=>calc.result&&void run(async()=>{await write(calc.result!,false);await hide()})}><PaletteCalculation expression={query} result={calc.result??calc.error??''}/></button>}<ul className="palette__list" role="listbox">{results.map((item,i)=>{const index=i+(calc?.result?1:0);return <li key={item.id} role="option" aria-selected={selected===index} data-selected={selected===index} className={'palette__item '+(selected===index?'palette__item--kb':'')+(hover===index?' palette__item--cursor':'')} onMouseEnter={()=>setHover(index)} onMouseLeave={()=>setHover(null)} onClick={()=>void run(async()=>{if(['clipboard','emoji','translate','calculator'].includes(item.id))open(item.id);else await invoke('snipcast_commands_run',{id:item.id})})}><span className="palette__item-row"><Icon value={item.icon}/><PaletteItemText title={item.title} preview={item.kind==='application'?'Приложение':'Команда'}/></span></li>})}</ul>{!results.length&&!calc&&<p className="palette__empty">{group==='application'&&!query.trim()?'Введите название приложения':catalog.scanning?'Обновляется список приложений…':'Ничего не найдено'}</p>}</div>}
 {section==='clipboard'&&<><ClipboardHistoryList clips={clips} selected={selected} selection={selection} loading={historyLoading} error={historyError} resetKey={`${query}\0${filter}\0${openEpoch}`} onSelect={selectRow} onPaste={()=>void run(()=>clipAction('paste'))} onNearEnd={list=>{if(list.scrollTop+list.clientHeight>=list.scrollHeight-80&&clips.length<total&&!historyLoading)void refreshClips(true)}}/><div className={`commands__preview${detail?.image?' commands__preview--image':''}`}><ClipPreview detail={detail}/></div></>}
 {section==='emoji'&&<EmojiGrid items={emojiList} popularCount={emojiData.popularCount} grouped={emojiData.grouped} columns={cfg.emojiColumns} selected={selected} tone={cfg.skinTone} onChoose={i=>{setSelected(i);const e=emojiList[i];void run(async()=>{await write(e.emoji+(e.tone?cfg.skinTone:''),cfg.emojiAction==='paste','emoji:'+e.emoji);if(cfg.emojiAction==='copy')await hide()})}}/>}
 {section==='translate'&&<div className="commands__translator"><div className="commands__languages"><ThemedSelect label="Исходный язык" value={source} preferBelow onChange={value=>void run(()=>rememberLanguages(value,target))} options={languageOptions('source',cfg.languageUsage??{})}/><button aria-label="Поменять языки" onClick={()=>void run(()=>rememberLanguages(target,source))}>⇄</button><ThemedSelect label="Язык перевода" value={target} preferBelow onChange={value=>void run(()=>rememberLanguages(source,value))} options={languageOptions('target',cfg.languageUsage??{})}/></div><div className="commands__translation-fields"><textarea aria-label="Текст для перевода" placeholder="Введите текст…" value={input} onChange={e=>{editedRef.current=true;if(historyAt!==null)setHistoryAt(null);setInput(e.target.value)}}/><textarea aria-label="Результат перевода" placeholder={busy?'Переводим…':'Перевод'} value={translation} readOnly/></div><div className="palette__hints"><button disabled={!translation} onClick={()=>void run(()=>write(translation,false))}>Копировать</button><button disabled={!translation} onClick={()=>void run(()=>write(translation,true))}>Вставить</button><span>MyMemory · 5 000 символов/день</span></div></div>}
 </div>
 <PaletteHints primary={calc?.result&&selected===0?'Копировать результат':primaryLabel.toLowerCase()} back={section!=='root'&&!direct} groups={section==='root'} onPrimary={()=>{if(canPrimary)void run(()=>primary())}} onSettings={()=>void run(()=>invoke('snipcast_commands_run',{id:'command-settings'}))}>{section==='clipboard'&&<span>несколько <kbd>Shift</kbd></span>}{section==='translate'&&<span>пред. перевод <kbd>-</kbd> <kbd>+</kbd></span>}{section!=='root'&&<button className="commands__actions-button" onClick={()=>{setMenu(m=>!m);setActionQuery('')}}>Действия <kbd>Ctrl</kbd> <kbd>J</kbd></button>}</PaletteHints>
 {menu&&<div className="palette__modal-backdrop" onClick={e=>{if(e.currentTarget===e.target)setMenu(false)}}><div className="palette__modal palette__modal--bracket commands__actions" role="dialog" aria-label="Действия"><input type="text" className="palette__modal-input-bare" autoFocus aria-label="Поиск действий" placeholder="Поиск действий…" value={actionQuery} onChange={e=>setActionQuery(e.target.value)}/>{actions.filter(([label])=>label.toLowerCase().includes(actionQuery.toLowerCase())).map(([label,action])=><button className="palette__item" key={action} onClick={()=>{setMenu(false);void run(async()=>{if(action==='rename'){setRename(detail?.title??'');return}if(action==='settings'){await invoke('snipcast_commands_run',{id:'command-settings'});return}if(action==='primary'||action==='copy'){if(section==='clipboard')await clipAction(action==='copy'?'copy':'paste');else await primary(action==='copy');return}if(action==='calc-paste'&&calc?.result){await write(calc.result,true);return}await clipAction(action,action==='delete-recent'?'60':undefined)})}}>{label}</button>)}</div></div>}
 {rename!==null&&<div className="palette__modal-backdrop"><form className="palette__modal palette__modal--bracket" role="dialog" aria-label="Переименовать запись" onSubmit={e=>{e.preventDefault();void run(async()=>{await clipAction('rename',rename);setRename(null)})}}><header className="palette__modal-chrome"><h3 className="palette__modal-title">Переименовать запись</h3></header><div className="palette__modal-body"><input type="text" aria-label="Название записи" autoFocus className="palette__modal-input-bare" value={rename} onChange={e=>setRename(e.target.value)}/></div><footer className="palette__hints palette__modal-hints"><button type="submit">Сохранить</button><button type="button" onClick={()=>setRename(null)}>Отмена</button></footer></form></div>}
 </PaletteFrame>
}
const ClipPreview=memo(function ClipPreview({detail}:{detail:Clip|null}){
 if(!detail)return null;
 return <><div className="commands__content">{detail.image?<img src={detail.image} alt={detail.title}/>:<pre>{detail.files.length?detail.files.join('\n'):detail.text}</pre>}{detail.ocr&&<pre>{detail.ocr}</pre>}</div><dl><dt>Источник</dt><dd><Icon value={detail.icon}/>{detail.source||'Неизвестно'}</dd><dt>Тип</dt><dd>{kinds[detail.kind]}</dd><dt>{detail.kind==='image'?'Размеры':'Символов'}</dt><dd>{detail.kind==='image'?`${detail.width}×${detail.height}`:detail.characters}</dd><dt>Скопировано</dt><dd>{new Date(detail.created).toLocaleString('ru-RU')}</dd></dl></>;
});
function Icon({value}:{value:string}){return value.startsWith('data:image/')?<img className="commands__icon" src={value} alt=""/>:<span className="commands__icon">{value||'▣'}</span>}
