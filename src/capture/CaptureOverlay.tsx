import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { AppConfig } from "../types";
import { normalizeUiTheme, resolveUiTheme } from "../uiTheme";
import { isDemoMode } from "./demo";
import { drawShape, hitTest, shapeBounds, type Pt, type Shape, type ShapeKind, type DrawShape } from "./shapes";
import { useAnnotationScene } from "./useAnnotationScene";
import { transformAnnotations } from "./annotationCoordinates";
import { useTextTool } from "./useTextTool";
import { TextEditor, TextFrame } from "./TextEditor";
import { waitForCapturePaint } from "./capturePresentation";
import { proposedRect, formatPixel, mergeCandidates,indexCandidates,monitorRect, type CaptureCandidate,type ScreenMonitor } from "./captureAssist";
import { sumNumbers } from "./sumNumbers";
import { CaptureLoupe, type PixelSample } from "./CaptureLoupe";
import { CaptureShortcuts, type HintMotion } from "./CaptureShortcuts";
import {waitForPinPaint,type PinEditGeometry} from "./pinGeometry";
import "../capture.css";
import {ThemedSelect} from "../components/ThemedSelect";
import {useQuickSaveHover} from "../components/useQuickSaveHover";
import {actionHotkeyLabel,matchesAction,drawCenterGuides} from "./actionHotkeys";
import {VideoIcon} from "../video/VideoApp";

type PresetInfo = {
  title: string;
  dir: string;
  fileTemplate: string;
  action: "save" | "ocr" | "pin";
};

type CaptureInfo = {
  videoSelection?:boolean;
  sessionId?:string;
  monitors?:ScreenMonitor[];
  candidates?: CaptureCandidate[];
  cursor?: Pt | null;
  label: string;
  imageName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  /** Пресет, с которым открыт оверлей: подменяет сохранение и действие. */
  preset?: PresetInfo;
};

type Rect = { x: number; y: number; w: number; h: number };
type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Drag =
  | { mode: "new"; start: Pt; proposed: Rect | null; manual: boolean }
  | { mode: "move"; start: Pt; orig: Rect }
  | { mode: "resize"; handle: HandleId; orig: Rect }
  | { mode: "draw"; start: Pt }
  | { mode: "shapeMove"; id: number; grab: Pt; orig: Shape }
  | { mode: "shapePoint"; id: number; point: 1 | 2; orig: Shape };


const SWATCHES = [
  "#ff003c", // насыщенный красный — по умолчанию
  "#003cff", "#ff4f00", "#ffff00", "#ffffff",
  "#00ff32", "#00f5ff", "#ff00a8", "#000000", "#b000ff",
];
const HANDLES: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_SEL = 10;
const MIN_THICKNESS = 2;
const MAX_THICKNESS = 12;
const HOLD_MS = 250;

const DEMO_CFG: AppConfig = {
  paletteHotkey: "",
  autostart: false,
  theme: "dark",
  paletteListDensity: "normal",
  screenshotHotkey: "",
  screenshotFormat: "png",
  screenshotJpegQuality: 90,
  screenshotFileTemplate: "Snip {date} {time}",
  screenshotSaveDir: "",
  screenshotQuickLocations: [
    { name: "Рабочий стол", path: "C:\\Users\\demo\\Desktop" },
    { name: "Документы", path: "C:\\Users\\demo\\Documents" },
  ],
  screenshotOcrEngine: "system",
  screenshotOcrLanguage: "ru-RU",
  screenshotOcrQuality: "mobile",
  screenshotPresets: [],
  apiEnabled: false,
  apiPort: 52300,
  aiApiKey: "",
  aiModel: "",
};

// ---------------------------------------------------------------------------
// Геометрия
// ---------------------------------------------------------------------------

function rectFrom(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function applyResize(orig: Rect, handle: HandleId, pt: Pt, vw: number, vh: number): Rect {
  let { x, y, w, h } = orig;
  const ax = handle.includes("w") ? orig.x : orig.x + orig.w;
  const ay = handle.includes("n") ? orig.y : orig.y + orig.h;
  const dx = pt.x - ax;
  const dy = pt.y - ay;
  if (handle.includes("w")) {
    x = orig.x + dx;
    w = orig.w - dx;
  }
  if (handle.includes("e")) w = orig.w + dx;
  if (handle.includes("n")) {
    y = orig.y + dy;
    h = orig.h - dy;
  }
  if (handle.includes("s")) h = orig.h + dy;
  if (w < MIN_SEL) {
    if (handle.includes("w")) x = orig.x + orig.w - MIN_SEL;
    w = MIN_SEL;
  }
  if (h < MIN_SEL) {
    if (handle.includes("n")) y = orig.y + orig.h - MIN_SEL;
    h = MIN_SEL;
  }
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > vw) w = vw - x;
  if (y + h > vh) h = vh - y;
  return { x, y, w: Math.max(MIN_SEL, w), h: Math.max(MIN_SEL, h) };
}

/** Имя файла по шаблону из настроек (клиентский вариант, без обращения к бэкенду). */
function templateFileName(tpl: string, ext: string): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  return `${tpl
    .replace(/\{datetime\}/g, `${date}_${time}`)
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{n\}/g, String(Date.now() % 1000))}.${ext}`;
}

// ---------------------------------------------------------------------------
// Иконки панели инструментов (20×20, stroke 1.8, currentColor)
// ---------------------------------------------------------------------------

function SvgIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function IconLine() {
  return (
    <SvgIcon>
      <path d="M5 19 19 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </SvgIcon>
  );
}

function IconRect() {
  return (
    <SvgIcon>
      <rect x="5" y="7" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
    </SvgIcon>
  );
}

/** Мелкие иконки форм для панели опций инструмента «Фигура». */
function ShapeIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function IconShapeRect() {
  return (
    <ShapeIcon>
      <rect x="4" y="7" width="16" height="10" rx="1" stroke="currentColor" strokeWidth="1.8" />
    </ShapeIcon>
  );
}

function IconShapeSquare() {
  return (
    <ShapeIcon>
      <rect x="6" y="6" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.8" />
    </ShapeIcon>
  );
}

function IconShapeCircle() {
  return (
    <ShapeIcon>
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.8" />
    </ShapeIcon>
  );
}

function IconShapeEllipse() {
  return (
    <ShapeIcon>
      <ellipse cx="12" cy="12" rx="8" ry="5.5" stroke="currentColor" strokeWidth="1.8" />
    </ShapeIcon>
  );
}

function IconArrow() {
  return (
    <SvgIcon>
      <path
        d="M5 19 19 5M11 5h8v8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </SvgIcon>
  );
}

function IconText() {
  return (
    <SvgIcon>
      <path
        d="M5 6V4h14v2M12 4v16M9 20h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </SvgIcon>
  );
}

function IconOcr() {
  return (
    <SvgIcon>
      <path
        d="M8 4H6.5A2.5 2.5 0 0 0 4 6.5V8M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16M16 20h1.5a2.5 2.5 0 0 0 2.5-2.5V16M4.5 12h15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Искра ИИ: большая четырёхлучевая звезда + маленькая рядом. */
function IconAi() {
  return (
    <SvgIcon>
      <path
        d="M11 5.5l1.9 4.6 4.6 1.9-4.6 1.9-1.9 4.6-1.9-4.6L4.5 12l4.6-1.9L11 5.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M18.5 3.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z"
        fill="currentColor"
        stroke="none"
      />
    </SvgIcon>
  );
}

function IconSave() {
  return (
    <SvgIcon>
      <path
        d="M12 4v9m0 0-3.5-3.5M12 13l3.5-3.5M4.5 15v2.5A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5V15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </SvgIcon>
  );
}

function IconPin() {
  return (
    <SvgIcon>
      <path
        d="M9 4h6M12 4v6.2l3.3 3.3H8.7L12 10.2zM12 13.5V20"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </SvgIcon>
  );
}

function IconCopy() {
  return (
    <SvgIcon>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M15.5 5.5v-1a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </SvgIcon>
  );
}

// ---------------------------------------------------------------------------
// Компонент
// ---------------------------------------------------------------------------

export type PinAnnotationTarget = {
  url: string; width: number; height: number;
  sessionId?:number;
  revision?:number;
  onLayout?:(geometry:PinEditGeometry)=>void;
  imageRect?:{x:number;y:number;width:number;height:number};
  panelBounds?:{x:number;y:number;width:number;height:number};
  onApply: (png: string) => Promise<void>; onCancel: () => Promise<void>;
};

export function CaptureOverlay({ pinEditor }: { pinEditor?: PinAnnotationTarget } = {}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const tbRef = useRef<HTMLDivElement | null>(null);

  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [sourcePlacement,setSourcePlacement]=useState<Rect|null>(null);
  const sourcePlacementRef=useRef<Rect|null>(null);sourcePlacementRef.current=sourcePlacement;
  const [altHeld,setAltHeld]=useState(false);const altHeldRef=useRef(false);
  const [historyPosition,setHistoryPosition]=useState(-1);
  const historyCursor=useRef(-1),historyRequest=useRef(0),historyLoading=useRef(false),historyUrl=useRef<string|null>(null),historySourceId=useRef<string|null>(null);
  type HistoryEntry={id:string;width:number;height:number;originX:number;originY:number;selection:{x:number;y:number;width:number;height:number};annotations?:Shape[]};
  const historyEntries=useRef<HistoryEntry[]>([]);
  const [historyCount,setHistoryCount]=useState(0);
  const currentCapture=useRef<{info:CaptureInfo|null;url:string|null;selection:Rect|null;scene:ReturnType<typeof scene.snapshot>;placement:Rect|null;scale:number;viewport:{w:number;h:number};tool:ShapeKind|null;selectedId:number|null}|null>(null);
  const historyNavigation=useRef<(direction:number)=>Promise<void>>(async()=>{});
  const [loadError, setLoadError] = useState("");
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [k, setK] = useState(1);
  const [sel, renderSel] = useState<Rect | null>(null);
  const physicalSelection=useRef<Rect|null>(null);
  const [selecting, setSelecting] = useState(false);
  const [pointer, setPointer] = useState<Pt | null>(null);
  const [releasePoint,setReleasePoint]=useState<Pt|null>(null);
  const [detectionMode, setDetectionMode] = useState<"element" | "window">("element");
  const [colorFormat, setColorFormat] = useState<"hex" | "rgb">("hex");
  const [pixelSource, setPixelSource] = useState<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<Pt | null>(null);
  const pointerRafRef = useRef(0);
  const lastGesturePoint=useRef<Pt|null>(null);
  const strokeSamples=useRef<Pt[]>([]);
  const sampleRef = useRef<PixelSample | null>(null);
  const onPixelSample = useCallback((value: PixelSample | null) => { sampleRef.current = value; }, []);
  const assistRef = useRef({ mode: detectionMode, format: colorFormat });
  assistRef.current = { mode: detectionMode, format: colorFormat };
  const candidateIndex=useMemo(()=>indexCandidates(info?.candidates??[]),[info?.candidates]);
  const candidateIndexRef=useRef(candidateIndex);candidateIndexRef.current=candidateIndex;
  const suggestion = !selecting && !sel && pointer && info
    ? proposedRect(candidateIndex, pointer, detectionMode, info, vp) : null;
  const [draft, setDraft] = useState<Shape | null>(null);
  const scene = useAnnotationScene();
  const { shapes, setShapes } = scene;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tool, setTool] = useState<ShapeKind | null>(null);
  const [drawColor, setDrawColor] = useState(SWATCHES[0]!);
  /** Форма инструмента «Фигура»: прямоугольник/квадрат/круг/овал. */
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [drawThickness, setDrawThickness] = useState(4);
  const [drawOpacity,setDrawOpacity]=useState(1);
  const [drawFill,setDrawFill]=useState(false);
  const [textSize, setTextSize] = useState(22);
  const [textOutlineColor,setTextOutlineColor]=useState("#000000");
  const [textOutlineWidth,setTextOutlineWidth]=useState(2);
  const [textOutlineEnabled,setTextOutlineEnabled]=useState(false);
  const hintMotion=useRef<HintMotion>({move:null});
  const [hoverText, setHoverText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [videoFps,setVideoFps]=useState(30);
  const [videoAudio,setVideoAudio]=useState(false);
  const recordingAction=useRef<()=>Promise<void>>(async()=>{});
  const busyRef = useRef(false); busyRef.current = busy;
  const [ocrLoading, setOcrLoading] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [hoverQuick, setHoverQuick] = useState<number | null>(null);
  const quickHover=useQuickSaveHover(setQuickOpen,busy);
  const [tbSize, setTbSize] = useState<{ w: number; h: number } | null>(null);
  const [optsSize,setOptsSize]=useState({w:0,h:0});

  const dragRef = useRef<Drag | null>(null);
  const holdRef = useRef<{ timer: number; fired: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const dragSelectionBeforeRef = useRef<Rect | null>(null);
  const idSeqRef = useRef(1);
  const toastTimerRef = useRef(0);
  const saveQuickRef = useRef<((loc: { name: string; path: string }) => void) | null>(null);
  const presetRunRef = useRef(false);
  const runPresetActionRef = useRef<((preset: PresetInfo) => void) | null>(null);

  // Свежие значения для стабильных window-слушателей
  const selRef = useRef<Rect | null>(null);
  selRef.current = sel;
  const draftRef = useRef<Shape | null>(null);
  draftRef.current = draft;
  const kRef = useRef(1);
  kRef.current = k;
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const cfgRef = useRef<AppConfig | null>(null);
  cfgRef.current = cfg;
  const infoRef = useRef<CaptureInfo | null>(null);
  infoRef.current = info;
  const setSel=useCallback((r:Rect|null)=>{
    const bounds=sourcePlacementRef.current;
    if(r&&bounds){const x=Math.max(bounds.x,Math.min(r.x,bounds.x+bounds.w)),y=Math.max(bounds.y,Math.min(r.y,bounds.y+bounds.h));
      r={x,y,w:Math.max(0,Math.min(r.x+r.w,bounds.x+bounds.w)-x),h:Math.max(0,Math.min(r.y+r.h,bounds.y+bounds.h)-y)};}
    const i=infoRef.current,v=vpRef.current;
    physicalSelection.current=r&&i?{x:i.x+r.x*i.width/v.w,y:i.y+r.y*i.height/v.h,w:r.w*i.width/v.w,h:r.h*i.height/v.h}:null;
    selRef.current=r;renderSel(r);
  },[]);
  /** Метка окна, чей кадр загружен, но ещё не отрисован: ждём onLoad <img>. */
  const readySignalRef = useRef<string | null>(null);
  const presentationSeqRef = useRef(0);
  const presentableImageRef = useRef<string | null>(null);
  const shownListenerRef = useRef<Promise<unknown> | null>(null);
  const candidatesListenerRef = useRef<Promise<unknown> | null>(null);
  const pendingCandidatesRef = useRef(new Map<string, CaptureCandidate[]>());
  const [presented, setPresented] = useState(isDemoMode);
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const textTool = useTextTool({ scene, select: setSelectedId, leaveTool: () => setTool(null),
    nextId: () => idSeqRef.current++, color: drawColor, fontSize: textSize,
    outlineColor:textOutlineColor,outlineWidth:textOutlineEnabled?textOutlineWidth:0,opacity:drawOpacity });
  const textToolRef = useRef(textTool);
  textToolRef.current = textTool;
  const edit = textTool.edit;

  const demo = isDemoMode();
  useEffect(()=>{
    if(demo||pinEditor)return;
    const update=()=>{const target=document.activeElement;void invoke("snipcast_capture_keyboard_state",{
      textInput:target instanceof HTMLElement&&!!target.closest("textarea,input,[contenteditable=true]"),suspended:busy,
    }).catch(error=>console.error("[Snipcast] capture keyboard",error));};
    update();window.addEventListener("focusin",update);window.addEventListener("focusout",update);
    return()=>{window.removeEventListener("focusin",update);window.removeEventListener("focusout",update);};
  },[demo,!!pinEditor,busy,edit?.key]);
  /** Номер сессии захвата: окно живое, при каждом новом показе +1 → перезагрузка. */
  const [sessionSeq, setSessionSeq] = useState(0);
  const pinEditorRef = useRef(pinEditor);
  pinEditorRef.current = pinEditor;
  const pinRect = pinEditor ? (() => {
    if(pinEditor.imageRect){const r=pinEditor.imageRect,dpr=window.devicePixelRatio||1;return {x:r.x/dpr,y:r.y/dpr,w:r.width/dpr,h:r.height/dpr};}
    const scale = Math.max(.01, Math.min(1, (vp.w-32)/pinEditor.width, (vp.h-210)/pinEditor.height));
    const w = pinEditor.width*scale, h = pinEditor.height*scale;
    return { x:(vp.w-w)/2, y:16, w,h };
  })() : null;
  const previousPinRect=useRef<Rect|null>(null);
  useLayoutEffect(() => {
    if (!pinEditor || !pinRect) return;
    const old=previousPinRect.current;
    if(old){scene.translate(pinRect.x-old.x,pinRect.y-old.y);textTool.translate(pinRect.x-old.x,pinRect.y-old.y);}
    previousPinRect.current=pinRect;
    selRef.current = pinRect; setSel(pinRect);
    setK(pinEditor.width/pinRect.w);
  }, [pinEditor?.width,pinEditor?.height,pinEditor?.imageRect,vp.w,vp.h]);

  // The native window appears transparent. Start its fade only AFTER show(),
  // never while a prewarmed WebView is still hidden.
  useEffect(() => {
    if (demo || pinEditor) return;
    let dead = false;
    const un = listen<string>("snipcast://capture-shown", (event) => {
      if (!dead && event.payload === presentableImageRef.current && imgRef.current?.complete) {
        setPresented(true);
      }
    });
    shownListenerRef.current = un;
    return () => { dead = true; void un.then((f) => f()); };
  }, [demo, !!pinEditor]);

  useEffect(() => {
    if (demo || pinEditor) return;
    let dead = false;
    const un = listen<{ imageName: string; candidates: CaptureCandidate[] }>("snipcast://capture-candidates", ({ payload }) => {
      if (dead || (infoRef.current && infoRef.current.imageName !== payload.imageName)) return;
      pendingCandidatesRef.current.set(payload.imageName, mergeCandidates(pendingCandidatesRef.current.get(payload.imageName) ?? [], payload.candidates));
      setInfo(prev => prev?.imageName === payload.imageName
        ? { ...prev, candidates: mergeCandidates(prev.candidates ?? [], payload.candidates) } : prev);
    });
    candidatesListenerRef.current = un;
    return () => { dead = true; void un.then(f => f()); };
  }, [demo, !!pinEditor]);

  useEffect(()=>{
    if(demo||pinEditor)return;let alive=true;historyRequest.current++;historyCursor.current=-1;historySourceId.current=null;currentCapture.current=null;
    sourcePlacementRef.current=null;setSourcePlacement(null);setHistoryPosition(-1);
    if(historyUrl.current){URL.revokeObjectURL(historyUrl.current);historyUrl.current=null;}
    void invoke<HistoryEntry[]>("snipcast_capture_history_list").then(entries=>{if(alive){historyEntries.current=entries;setHistoryCount(entries.length);}}).catch(()=>{});
    return()=>{alive=false;historyRequest.current++;if(historyUrl.current){URL.revokeObjectURL(historyUrl.current);historyUrl.current=null;}};
  },[sessionSeq,demo,!!pinEditor]);
  useEffect(()=>{
    const update=(e:KeyboardEvent)=>{altHeldRef.current=e.altKey;setAltHeld(e.altKey);if(e.altKey)setPointer(pointerRef.current);if(e.key==="Alt")e.preventDefault();};
    const clear=()=>{altHeldRef.current=false;setAltHeld(false);};
    window.addEventListener("keydown",update,true);window.addEventListener("keyup",update,true);window.addEventListener("blur",clear);
    return()=>{window.removeEventListener("keydown",update,true);window.removeEventListener("keyup",update,true);window.removeEventListener("blur",clear);};
  },[]);
  const historyContext=()=>{
    if(demo||pinEditorRef.current)return null;const r=selRef.current,i=infoRef.current,scale=kRef.current,b=sourcePlacementRef.current;
    if(!r||!i)return null;
    const annotations=transformAnnotations(textToolRef.current.commit(),scale,{x:-(b?.x??0)*scale,y:-(b?.y??0)*scale},true)
      .map((shape,index)=>({...shape,id:index+1}));
    return {name:historySourceId.current??i.imageName,selection:{x:Math.max(0,Math.round((r.x-(b?.x??0))*scale)),y:Math.max(0,Math.round((r.y-(b?.y??0))*scale)),
      width:Math.max(1,Math.round(r.w*scale)),height:Math.max(1,Math.round(r.h*scale))},annotations};
  };
  const persistHistory=async(context:ReturnType<typeof historyContext>)=>{if(!context)return;
    try{await invoke("snipcast_capture_history_record",context);}catch(err){console.error("[Snipcast] screenshot history",err);}
  };
  historyNavigation.current=async(direction:number)=>{
    if(demo||pinEditorRef.current||infoRef.current?.videoSelection||dragRef.current||textToolRef.current.gestureRef.current||(busyRef.current&&!historyLoading.current))return;
    if(!historyEntries.current.length)return;
    const next=Math.max(-1,Math.min(historyEntries.current.length-1,historyCursor.current+direction));if(next===historyCursor.current)return;
    const seq=++historyRequest.current;
    if(historyCursor.current===-1){textToolRef.current.commit();currentCapture.current={info:infoRef.current,url:imgUrl,selection:selRef.current,scene:scene.snapshot(),placement:sourcePlacementRef.current,scale:kRef.current,viewport:vpRef.current,tool:toolRef.current,selectedId:selectedIdRef.current};}
    historyCursor.current=next;historyLoading.current=true;setBusy(true);
    try{
      if(next===-1){const saved=currentCapture.current;if(!saved)return;
        const view=vpRef.current,source=saved.info;const fit=source?Math.min(view.w/source.width,view.h/source.height):1;
        const placement=source?{x:(view.w-source.width*fit)/2,y:(view.h-source.height*fit)/2,w:source.width*fit,h:source.height*fit}:null;
        const ratio=source?fit*saved.scale:1;
        sourcePlacementRef.current=placement;setSourcePlacement(placement);setInfo(source);setImgUrl(saved.url);setK(saved.scale/ratio);scene.restore(saved.scene);
        if(saved.placement)scene.translate(-saved.placement.x,-saved.placement.y);if(ratio!==1)scene.scale(ratio,ratio);if(placement&&(placement.x||placement.y))scene.translate(placement.x,placement.y);
        setSel(saved.selection?{x:(saved.selection.x-(saved.placement?.x??0))*ratio+(placement?.x??0),y:(saved.selection.y-(saved.placement?.y??0))*ratio+(placement?.y??0),w:saved.selection.w*ratio,h:saved.selection.h*ratio}:null);
        setTool(saved.tool);setSelectedId(saved.selectedId);
        historySourceId.current=null;setHistoryPosition(-1);
      }else{
        const item=historyEntries.current[next]!;
        const loaded=await invoke<{entry:HistoryEntry;png:string}>("snipcast_capture_history_open",{id:item.id});
        const binary=Uint8Array.from(atob(loaded.png),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([binary],{type:"image/png"}));
        const image=new Image();image.src=url;try{await image.decode();}catch{URL.revokeObjectURL(url);throw new Error("Повреждённый снимок истории");}
        if(seq!==historyRequest.current){URL.revokeObjectURL(url);return;}
        const entry=loaded.entry,view=vpRef.current;const fit=Math.min(view.w/entry.width,view.h/entry.height);
        const placement={x:(view.w-entry.width*fit)/2,y:(view.h-entry.height*fit)/2,w:entry.width*fit,h:entry.height*fit};
        sourcePlacementRef.current=placement;setSourcePlacement(placement);setK(1/fit);
        if(historyUrl.current)URL.revokeObjectURL(historyUrl.current);historyUrl.current=url;
        historySourceId.current=entry.id;setInfo({...currentCapture.current!.info!,candidates:[],preset:undefined});setImgUrl(url);
        scene.reset();
        setShapes(transformAnnotations(entry.annotations??[],fit,placement).map(shape=>({...shape,id:idSeqRef.current++})));
        setTool(null);setSelectedId(null);setSelecting(false);
        setSel({x:placement.x+entry.selection.x*fit,y:placement.y+entry.selection.y*fit,w:entry.selection.width*fit,h:entry.selection.height*fit});setHistoryPosition(next);
      }
    }catch(err){
      if(seq===historyRequest.current){const broken=historyCursor.current;historyEntries.current.splice(broken,1);setHistoryCount(historyEntries.current.length);historyCursor.current=direction>0?broken-1:broken;showToast("error",String(err));void historyNavigation.current(direction);}
    }finally{if(seq===historyRequest.current){historyLoading.current=false;setBusy(false);}}
  };

  // Загрузка: инфо о захвате + PNG-байты + конфиг
  useEffect(() => {
    let dead = false;
    let objectUrl: string | null = null;

    if (pinEditor) {
      setInfo({ label:"pin-editor", imageName:"", x:0,y:0,width:pinEditor.width,height:pinEditor.height,scale:1 });
      setImgUrl(pinEditor.url); setPresented(true);
      if (demo) setCfg(DEMO_CFG);
      else void invoke<AppConfig>("snipcast_get_config").then(c => { if (!dead) setCfg(c); }).catch(() => {});
      return () => { dead = true; };
    }

    if (demo) {
      setInfo({ label: "capture-0", imageName: "", x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1 });
      setK(window.devicePixelRatio || 1);
      setCfg(DEMO_CFG);
      return;
    }

    (async () => {
      try {
        await candidatesListenerRef.current;
        const i = await invoke<CaptureInfo>("snipcast_capture_info");
        const buf = await invoke<ArrayBuffer>("snipcast_capture_image_data", { name: i.imageName });
        objectUrl = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        if (dead) return;
        setInfo({ ...i, candidates: mergeCandidates(i.candidates ?? [], pendingCandidatesRef.current.get(i.imageName) ?? []) });
        if (i.cursor) {
          const pt = { x: (i.cursor.x-i.x) * window.innerWidth/i.width, y: (i.cursor.y-i.y) * window.innerHeight/i.height };
          if (pt.x >= 0 && pt.y >= 0 && pt.x < window.innerWidth && pt.y < window.innerHeight) {
            pointerRef.current = pt; setPointer(pt);
          }
        }
        setK(i.width/window.innerWidth);
        setImgUrl(objectUrl);
        setLoadError("");
        // Сигнал «окно готово» отправляем не здесь, а из onLoad картинки:
        // кадр должен быть реально нарисован, иначе show() вскрывает окно
        // со СТАРЫМ кадром и выделением прошлой сессии (то самое мигание).
        readySignalRef.current = i.label;
      } catch (e) {
        console.error("[Snipcast] не удалось открыть снимок:", e);
        if (!dead) setLoadError(String(e));
      }
    })();

    void invoke<AppConfig>("snipcast_get_config")
      .then((c) => {
        if (!dead) setCfg(c);
      })
      .catch((e) => console.error("[Snipcast] не удалось загрузить настройки:", e));

    return () => {
      dead = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSeq,pinEditor?.url,pinEditor?.width,pinEditor?.height]);

  // Окно оверлея переиспользуется между захватами (создаётся один раз):
  // новый захват бэкенд объявляет событием, и мы перезагружаем сессию.
  // Старое выделение/фигуры сбрасываем СРАЗУ в обработчике — до любого
  // показа окна, чтобы не мелькала рамка прошлой сессии.
  useEffect(() => {
    if (demo || pinEditor) return;
    const un = listen("snipcast://capture-session", () => {
      presentationSeqRef.current += 1;
      presentableImageRef.current = null;
      readySignalRef.current = null;
      setPresented(false);
      setSel(null);
      setSelecting(false);
      setPointer(null); pointerRef.current = null;
      setReleasePoint(null);
      cancelAnimationFrame(pointerRafRef.current); pointerRafRef.current = 0;
      sampleRef.current = null; setPixelSource(null);
      setInfo(null); setDetectionMode("element"); setColorFormat("hex");
      infoRef.current = null; pendingCandidatesRef.current.clear();
      setDraft(null); draftRef.current=null; strokeSamples.current=[]; lastGesturePoint.current=null;
      scene.reset();
      setSelectedId(null);
      setTool(null);
      textTool.reset();
      dragRef.current = null;
      setToast(null);
      setQuickOpen(false);
      setLoadError("");
      // Старый кадр вычищаем сразу: до прихода нового DOM без картинки,
      // чтобы показ не мог вскрыть снимок прошлой сессии.
      setImgUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setSessionSeq((n) => n + 1);
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, !!pinEditor]);

  // Размер окна (CSS px) — выделение живёт в этих координатах
  useEffect(() => {
    const onResize = () => {
      const next={w:window.innerWidth,h:window.innerHeight};
      const source=sourcePlacementRef.current;
      if(source&&!pinEditorRef.current){
        const image=imgRef.current;if(image){const fit=Math.min(next.w/image.naturalWidth,next.h/image.naturalHeight);
          const bounds={x:(next.w-image.naturalWidth*fit)/2,y:(next.h-image.naturalHeight*fit)/2,w:image.naturalWidth*fit,h:image.naturalHeight*fit};
          const ratio=bounds.w/source.w,r=selRef.current;scene.translate(-source.x,-source.y);scene.scale(ratio,ratio);scene.translate(bounds.x,bounds.y);
          sourcePlacementRef.current=bounds;setSourcePlacement(bounds);setK(1/fit);
          if(r)setSel({x:bounds.x+(r.x-source.x)*ratio,y:bounds.y+(r.y-source.y)*ratio,w:r.w*ratio,h:r.h*ratio});
        }
      }else if(!pinEditorRef.current && infoRef.current){
        const old=vpRef.current,s=physicalSelection.current,i=infoRef.current;
        const sx=next.w/old.w,sy=next.h/old.h;
        if(s){const resized={x:(s.x-i.x)*next.w/i.width,y:(s.y-i.y)*next.h/i.height,w:s.w*next.w/i.width,h:s.h*next.h/i.height};selRef.current=resized;renderSel(resized);}
        setReleasePoint(p=>p?{x:p.x*sx,y:p.y*sy}:null);
        scene.scale(sx,sy);setK(infoRef.current.width/next.w);
      }
      setVp(next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const showToast = (kind: "ok" | "error", text: string) => {
    setToast({ kind, text });
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  };

  const closeCapture = useCallback(() => {
    if (pinEditorRef.current) {
      if (busyRef.current) return;
      void pinEditorRef.current.onCancel().catch(e => showToast("error",String(e)));
      return;
    }
    if (demo) {
      console.log("[demo] snipcast_close_capture");
      return;
    }
    void invoke("snipcast_close_capture").catch((e) => console.error("[Snipcast] close_capture:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  const nextShapeId = () => idSeqRef.current++;
  const startVideo=async()=>{
    if(busyRef.current)return;const r=physicalSelection.current;if(!r)return;
    setBusy(true);
    try{if(demo){showToast("error","Запись видео доступна в приложении Windows");return;}
      await invoke("snipcast_video_start",{options:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.w),height:Math.round(r.h),fps:videoFps,audio:videoAudio}});
    }catch(e){showToast("error",String(e));}finally{setBusy(false);}
  };
  recordingAction.current=startVideo;

  const flattenSelection = useCallback((includeGuides=false): string => {
    const snapshot = textToolRef.current.commit();
    const r = selRef.current;
    if (!r) return "";
    const kw = kRef.current || 1;
    const cvs = document.createElement("canvas");
    cvs.width = Math.max(1, Math.round(r.w * kw));
    cvs.height = Math.max(1, Math.round(r.h * kw));
    const ctx = cvs.getContext("2d");
    if (!ctx) return "";
    const img=imgRef.current,b=sourcePlacementRef.current;
    if(img&&img.naturalWidth>0){
      const x=pinEditorRef.current?0:Math.max(0,Math.round((r.x-(b?.x??0))*kw));
      const y=pinEditorRef.current?0:Math.max(0,Math.round((r.y-(b?.y??0))*kw));
      const width=Math.min(cvs.width,img.naturalWidth-x),height=Math.min(cvs.height,img.naturalHeight-y);
      ctx.drawImage(img,x,y,width,height,0,0,width,height);
    }else{ctx.fillStyle="#8a8a96";ctx.fillRect(0,0,cvs.width,cvs.height);}
    ctx.scale(kw,kw);ctx.translate(-r.x,-r.y);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    for (const s of snapshot) drawShape(ctx, s, 1);
    if(includeGuides)drawCenterGuides(ctx,r,kw);
    ctx.restore();
    return cvs.toDataURL("image/png").split(",")[1] ?? "";
  }, []);

  // ------------------------------------------------------------------
  // Действия
  // ------------------------------------------------------------------

  const runCopy = useCallback(async () => {
    if (!selRef.current || busy) return;
    const history=historyContext(),includeGuides=altHeldRef.current;
    setBusy(true);
    try {
      const png = flattenSelection(includeGuides);
      if (demo) {
        console.log("[demo] snipcast_capture_copy: png base64 length", png.length);
        showToast("ok", "Скопировано (демо)");
        return;
      }
      await invoke("snipcast_capture_copy", { png });
      await persistHistory(history);
      if (pinEditorRef.current) showToast("ok","Скопировано");
      else await invoke("snipcast_close_capture");
    } catch (e) {
      showToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, demo, flattenSelection]);

  const applyPinAnnotations = async () => {
    if (!pinEditor || busy) return;
    setBusy(true);
    try { await pinEditor.onApply(flattenSelection()); }
    catch (e) { showToast("error",String(e)); }
    finally { setBusy(false); }
  };

  const runOcr = useCallback(
    async (opts?: { closeOnSuccess?: boolean }) => {
      const r = selRef.current;
      const inf = infoRef.current;
      if (!r || busy) return;
      setBusy(true);
      setOcrLoading(true);
      try {
        const region = {
          label: inf?.label ?? "",
          x: Math.max(0, Math.round(r.x * kRef.current)),
          y: Math.max(0, Math.round(r.y * kRef.current)),
          width: Math.max(1, Math.round(r.w * kRef.current)),
          height: Math.max(1, Math.round(r.h * kRef.current)),
        };
        if (demo) {
          console.log("[demo] snipcast_ocr_region", region);
          showToast("ok", "Текст скопирован");
          if (opts?.closeOnSuccess) closeCapture();
          return;
        }
        const text = await invoke<string>("snipcast_ocr_region", region);
        await invoke("snipcast_clipboard_write_text", { text });
        showToast("ok", "Текст скопирован");
        // Автодействие пресета закрывает оверлей; кнопка панели — оставляет открытым.
        if (opts?.closeOnSuccess) await invoke("snipcast_close_capture");
      } catch (e) {
        showToast("error", String(e));
      } finally {
        setBusy(false);
        setOcrLoading(false);
      }
    },
    [busy, demo, closeCapture],
  );

  const runSum=async()=>{
    const r=selRef.current,inf=infoRef.current;if(!r||busyRef.current)return;
    setBusy(true);setOcrLoading(true);
    try{
      const text=demo?"12,50 7,25":await invoke<string>("snipcast_ocr_region",{
        label:inf?.label??"",x:Math.max(0,Math.round(r.x*kRef.current)),y:Math.max(0,Math.round(r.y*kRef.current)),
        width:Math.max(1,Math.round(r.w*kRef.current)),height:Math.max(1,Math.round(r.h*kRef.current))});
      const result=sumNumbers(text);if(!result){showToast("error","Числа не найдены");return;}
      if(demo)await navigator.clipboard.writeText(result.sum);else await invoke("snipcast_clipboard_write_text",{text:result.sum});
      showToast("ok",`Сумма: ${result.sum}`);
    }catch(e){showToast("error",String(e));}finally{setBusy(false);setOcrLoading(false);}
  };

  const saveWithDialog = useCallback(
    async (preset?: PresetInfo) => {
      if (!selRef.current || busy) return;
      const history=historyContext(),includeGuides=altHeldRef.current;
      setBusy(true);
      try {
        const ext = cfgRef.current?.screenshotFormat === "jpeg" ? "jpg" : "png";
        // Пресет подменяет шаблон и папку; пустые значения — откат к общим настройкам.
        const cfgTpl = cfgRef.current?.screenshotFileTemplate ?? "";
        const presetTpl = preset?.fileTemplate.trim() ?? "";
        const tpl = presetTpl || cfgTpl || "Snip {date} {time}";
        let defaultPath = templateFileName(tpl, ext);
        const dir = preset?.dir.trim() || cfgRef.current?.screenshotSaveDir?.trim() || "";
        if (!demo && dir) {
          // Путь-подсказка из бэкенда (шаблон пресета/настроек + защита от перезаписи);
          // при сбое — своё имя.
          try {
            defaultPath = await invoke<string>("snipcast_capture_save_path", { dir, ext, template: tpl });
          } catch {
            /* используем клиентское имя */
          }
        }
        if (demo) {
          console.log("[demo] диалог сохранения, defaultPath:", defaultPath);
          showToast("ok", "Сохранено (демо)");
          return;
        }
        const path = await save({
          defaultPath,
          filters: [
            {
              name: "Изображение",
              extensions: cfgRef.current?.screenshotFormat === "jpeg" ? ["jpg", "jpeg"] : ["png"],
            },
          ],
        });
        if (!path) return;
        const png = flattenSelection(includeGuides);
        await invoke("snipcast_capture_save", { png, path });
        await persistHistory(history);
        if (pinEditorRef.current) showToast("ok", "Сохранено в файл");
        else await invoke("snipcast_close_capture");
      } catch (e) {
        showToast("error", String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, demo, flattenSelection],
  );

  const saveToQuick = useCallback(
    async (loc: { name: string; path: string }) => {
      if (!selRef.current || busy) return;
      const history=historyContext(),includeGuides=altHeldRef.current;
      setBusy(true);
      setQuickOpen(false);
      try {
        if (demo) {
          console.log("[demo] быстрое сохранение в", loc);
          showToast("ok", `Сохранено: ${loc.name} (демо)`);
          return;
        }
        const ext = cfgRef.current?.screenshotFormat === "jpeg" ? "jpg" : "png";
        const path = await invoke<string>("snipcast_capture_save_path", { dir: loc.path, ext });
        const png = flattenSelection(includeGuides);
        await invoke("snipcast_capture_save", { png, path });
        await persistHistory(history);
        if (pinEditorRef.current) showToast("ok", `Сохранено: ${loc.name}`);
        else await invoke("snipcast_close_capture");
      } catch (e) {
        showToast("error", String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, demo, flattenSelection],
  );
  saveQuickRef.current = saveToQuick;

  const runPin = useCallback(async () => {
    const r = selRef.current;
    const inf = infoRef.current;
    if (!r || !inf || busy) return;
    const history=historyContext(),includeGuides=altHeldRef.current;
    setBusy(true);
    try {
      const png = flattenSelection(includeGuides);
      const kw = kRef.current || 1;
      const box = {
        png,
        x: inf.x + Math.round(r.x * (sourcePlacementRef.current?(window.devicePixelRatio||1):kw)),
        y: inf.y + Math.round(r.y * (sourcePlacementRef.current?(window.devicePixelRatio||1):kw)),
        width: Math.max(1, Math.round(r.w * kw)),
        height: Math.max(1, Math.round(r.h * kw)),
      };
      if (demo) {
        console.log("[demo] snipcast_capture_pin", box);
        return;
      }
      await invoke("snipcast_capture_pin", box);
      await persistHistory(history);
      await invoke("snipcast_close_capture");
    } catch (e) {
      showToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, demo, flattenSelection]);

  // Прикрепить выделение к чату ИИ-агента; окно ввода откроется по центру
  // под тулбаром. Оверлей НЕ закрываем: он скроется, когда пользователь
  // отправит промпт из окна чата (так решает бэкенд).
  const runAiAgent = useCallback(async () => {
    const r = selRef.current;
    const inf = infoRef.current;
    if (!r || !inf || busy) return;
    if (!cfgRef.current?.aiApiKey) {
      if (demo) {
        console.log("[demo] snipcast_ai_attach: ключ не задан");
        return;
      }
      showToast("error", "Сначала укажите API-ключ Polza в Настройки → ИИ");
      return;
    }
    setBusy(true);
    try {
      const png = flattenSelection();
      const kw = kRef.current || 1;
      // Прямоугольник тулбара в физических экранных координатах — окно
      // ввода центрируется под ним (или над, если внизу не влезает).
      const bar = tbRef.current?.getBoundingClientRect();
      const box = {
        png,
        x: inf.x + Math.round((bar?.left ?? r.x) * kw),
        y: inf.y + Math.round((bar?.top ?? r.y) * kw),
        width: Math.max(1, Math.round((bar?.width ?? r.w) * kw)),
        height: Math.max(1, Math.round((bar?.height ?? r.h) * kw)),
      };
      if (demo) {
        console.log("[demo] snipcast_ai_attach", box);
        return;
      }
      await invoke("snipcast_ai_attach", box);
    } catch (e) {
      showToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, demo, flattenSelection]);

  // Сохранение пресета без диалога: путь строит бэкенд (шаблон + защита от перезаписи).
  const runPresetSave = useCallback(
    async (preset: PresetInfo) => {
      if (!selRef.current || busy) return;
      const history=historyContext(),includeGuides=altHeldRef.current;
      setBusy(true);
      try {
        const png = flattenSelection(includeGuides);
        if (demo) {
          console.log("[demo] пресет-сохранение без диалога:", preset.title);
          showToast("ok", "Сохранено (демо)");
          return;
        }
        const ext = cfgRef.current?.screenshotFormat === "jpeg" ? "jpg" : "png";
        const dir = preset.dir.trim() || cfgRef.current?.screenshotSaveDir?.trim() || "";
        const template = preset.fileTemplate.trim();
        const path = await invoke<string>("snipcast_capture_save_path", {
          dir,
          ext,
          template: template || undefined,
        });
        await invoke("snipcast_capture_save", { png, path });
        await persistHistory(history);
        await invoke("snipcast_close_capture");
      } catch (e) {
        showToast("error", String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, demo, flattenSelection],
  );

  // Автодействие пресета после рисования рамки. Ref-щит не даёт запуститься дважды
  // до того, как состояние busy успеет обновиться.
  const runPresetAction = useCallback(
    async (preset: PresetInfo) => {
      if (busy || presetRunRef.current) return;
      presetRunRef.current = true;
      try {
        if (preset.action === "ocr") {
          await runOcr({ closeOnSuccess: true });
        } else if (preset.action === "pin") {
          await runPin();
        } else {
          await runPresetSave(preset);
        }
      } finally {
        presetRunRef.current = false;
      }
    },
    [busy, runOcr, runPin, runPresetSave],
  );
  runPresetActionRef.current = runPresetAction;

  // ------------------------------------------------------------------
  // Мышь: выделение, рамка, фигуры
  // ------------------------------------------------------------------

  /** Какой kind рисуем текущим инструментом («Фигура» — выбранная форма). */
  const activeDrawKind = useCallback(
    (): DrawShape["kind"] => (tool === "rect" ? shapeKind : tool) as DrawShape["kind"],
    [tool, shapeKind],
  );

  const onRootPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    altHeldRef.current=e.altKey;setAltHeld(e.altKey);
    if (pinEditor && busy) return;
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".capture__ui")) return;
    if (t.closest(".capture__text-edit")) return;
    if (t.closest(".capture__text-edit-wrap")) return;
    // Дефолтная фокусация mousedown сбивает фокус с только что открытого
    // текстового редактора (клик попадает в нефокусируемую рамку/канву,
    // фокус уходит на body, textarea ловит blur и мгновенно закрывается).
    e.preventDefault();
    const pt = { x: e.clientX, y: e.clientY };

    if (textTool.editRef.current) {
      textTool.commit();
      return;
    }
    if (textTool.gestureRef.current) return;
    dragSelectionBeforeRef.current = sel;
    const s = sel;
    const handleEl = t.closest("[data-handle]") as HTMLElement | null;
    if (!pinEditor && s && handleEl) {
      scene.begin();
      dragRef.current = { mode: "resize", handle: handleEl.dataset.handle as HandleId, orig: s };
      return;
    }

    const kpEl = t.closest("[data-kp]") as HTMLElement | null;
    const sel1 = shapes.find((x) => x.id === selectedId);
    if (s && kpEl && sel1) {
      scene.begin();
      dragRef.current = {
        mode: "shapePoint",
        id: sel1.id,
        point: Number(kpEl.dataset.kp) === 1 ? 1 : 2,
        orig: sel1,
      };
      return;
    }

    const inside =
      !!s && pt.x >= s.x && pt.x <= s.x + s.w && pt.y >= s.y && pt.y <= s.y + s.h;
    if (pinEditor && !inside) { textTool.commit(); setSelectedId(null); return; }
    if (inside && s) {
      // Верхняя фигура под курсором — выбрать и тащить (даже при активном инструменте).
      for (let i = shapes.length - 1; i >= 0; i--) {
        const sh = shapes[i]!;
        if (hitTest(sh, pt)) {
          if (sh.kind === "text") { textTool.beginMove(e, sh); return; }
          scene.begin();
          setSelectedId(sh.id);
          dragRef.current = { mode: "shapeMove", id: sh.id, grab: pt, orig: sh };
          return;
        }
      }
      // Пустое место внутри выделения при активном инструменте — сразу
      // рисуем новую фигуру (клик не тратится на снятие выбора фигуры).
      if (tool) {
        setSelectedId(null);
        if (tool === "text") { textTool.beginCreate(e); return; }
        scene.begin();
        strokeSamples.current=[];
        dragRef.current = { mode: "draw", start: pt };
        const initial:Shape={ id: nextShapeId(), kind: activeDrawKind(), color: drawColor, thickness: drawThickness, filled:drawFill,opacity:drawOpacity,p1: pt, p2: pt }; draftRef.current=initial;setDraft(initial);
        return;
      }
      // Инструмент не активен: первый драг снимает выбор фигуры, дальше — рамка.
      if (selectedId != null) {
        setSelectedId(null);
        return;
      }
      if (!pinEditor) dragRef.current = { mode: "move", start: pt, orig: s };
      return;
    }

    // Фон при активном инструменте: тоже сразу создаём новую фигуру/текст,
    // а не тянем выделение (иначе требовался второй клик).
    if (tool) {
      setSelectedId(null);
      if (tool === "text") { textTool.beginCreate(e); return; }
      scene.begin();
      strokeSamples.current=[];
      dragRef.current = { mode: "draw", start: pt };
      const initial:Shape={ id: nextShapeId(), kind: activeDrawKind(), color: drawColor, thickness: drawThickness, filled:drawFill,opacity:drawOpacity,p1: pt, p2: pt }; draftRef.current=initial;setDraft(initial);
      return;
    }

    // Фон: тянем новое выделение
    const inf = infoRef.current;
    const proposed = inf ? proposedRect(candidateIndexRef.current, pt, assistRef.current.mode, inf, vpRef.current) : null;
    dragRef.current = { mode: "new", start: pt, proposed, manual: false };
    setSelecting(true);
    setSelectedId(null);
    setDraft(null);
    setSel(proposed);
  };

  // Колесо мыши при активном инструменте — толщина линии (и кегль текста).
  // Применяем и к выбранной фигуре — как у ползунка в панели опций.
  const onRootWheel = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest(".capture__ui") || dragRef.current || textTool.gestureRef.current || busy) return;
    const dir = e.deltaY > 0 ? -1 : e.deltaY < 0 ? 1 : 0;
    if (!dir) return;
    const selected=scene.ref.current.find(s=>s.id===selectedIdRef.current);
    const editing=textTool.editRef.current?.shape;
    if (editing || tool === "text" || selected?.kind === "text") {
      e.preventDefault();
      const current=editing?.fontSize??(selected?.kind==="text"?selected.fontSize:textSize);
      applyTextSize(Math.max(8,Math.min(128,current+dir))/textBaseWidth*100);
      return;
    }
    if (!tool) return;
    e.preventDefault();
    const next = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, drawThickness + dir));
    applyThickness(next);
  };
  const wheelHandler=useRef(onRootWheel);wheelHandler.current=onRootWheel;
  useEffect(()=>{
    const root=rootRef.current;if(!root)return;
    const wheel=(event:WheelEvent)=>wheelHandler.current(event);
    root.addEventListener("wheel",wheel,{passive:false});
    return()=>root.removeEventListener("wheel",wheel);
  },[]);

  const onRootDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest(".capture__ui") || t.closest(".capture__text-edit")) return;
    const pt = { x: e.clientX, y: e.clientY };
    for (let i = shapes.length - 1; i >= 0; i--) {
      const sh = shapes[i]!;
      if (hitTest(sh, pt)) {
        if (sh.kind === "text") textTool.open(sh, pt);
        return;
      }
    }
  };

  useEffect(() => {
    const hidden = new Set<HTMLElement>();
    const restore = () => {
      for (const panel of hidden) panel.removeAttribute("data-drawing-occluded");
      hidden.clear();
    };
    const avoidPointer = (event: PointerEvent) => {
      const mode = dragRef.current?.mode;
      if (!["draw", "shapeMove", "shapePoint"].includes(mode ?? "") && !textToolRef.current.gestureRef.current) {
        restore();
        return;
      }
      // Treat the main toolbar and its auxiliary panels as one block. Keep them
      // mounted and measured so hiding them cannot change their placement.
      const panels = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".capture__toolbar,.capture__opts,.capture__quick") ?? []);
      const covered = panels.some(panel => {
        const r = panel.getBoundingClientRect();
        return event.clientX >= r.left - 8 && event.clientX <= r.right + 8 &&
          event.clientY >= r.top - 8 && event.clientY <= r.bottom + 8;
      });
      for (const panel of panels) {
        panel.toggleAttribute("data-drawing-occluded", covered);
        if (covered) hidden.add(panel); else hidden.delete(panel);
      }
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") restore(); };
    window.addEventListener("pointermove", avoidPointer, true);
    window.addEventListener("pointerup", restore, true);
    window.addEventListener("pointercancel", restore, true);
    window.addEventListener("blur", restore);
    window.addEventListener("keydown", onKey, true);
    return () => {
      restore();
      window.removeEventListener("pointermove", avoidPointer, true);
      window.removeEventListener("pointerup", restore, true);
      window.removeEventListener("pointercancel", restore, true);
      window.removeEventListener("blur", restore);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointerRef.current={x:e.clientX,y:e.clientY};
      hintMotion.current.move?.(pointerRef.current);
      if (altHeldRef.current || !selRef.current || dragRef.current?.mode === "new") setPointer(pointerRef.current);
      // Подсветка пункта меню быстрых мест, пока кнопка удерживается
      if (holdRef.current?.fired) {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-quick-idx]");
        const idx = el ? Number((el as HTMLElement).dataset.quickIdx ?? "-1") : -1;
        setHoverQuick(idx >= 0 ? idx : null);
      }

      const d = dragRef.current;
      if (!d) return;
      const pt = { x: e.clientX, y: e.clientY };
      lastGesturePoint.current=pt;
      const vw = vpRef.current.w;
      const vh = vpRef.current.h;

      if (d.mode === "new") {
        if (!d.manual && Math.hypot(pt.x-d.start.x, pt.y-d.start.y) <= 4) return;
        d.manual = true;
        const r = rectFrom(d.start, pt);
        setSel({
          x: Math.max(0, r.x),
          y: Math.max(0, r.y),
          w: Math.min(r.w, vw - Math.max(0, r.x)),
          h: Math.min(r.h, vh - Math.max(0, r.y)),
        });
        return;
      }
      if (d.mode === "move") {
        const x = Math.min(Math.max(d.orig.x + pt.x - d.start.x, 0), vw - d.orig.w);
        const y = Math.min(Math.max(d.orig.y + pt.y - d.start.y, 0), vh - d.orig.h);
        setSel({ x, y, w: d.orig.w, h: d.orig.h });
        return;
      }
      if (d.mode === "resize") {
        setSel(applyResize(d.orig, d.handle, pt, vw, vh));
        return;
      }
      if (d.mode === "draw") {
        const update=(prev:Shape|null):Shape|null => {
          if (!prev) return prev;
          let p2 = pt;
          // Квадрат и круг рисуются с равными сторонами (по большей оси).
          if (prev.kind === "square" || prev.kind === "circle") {
            const m = Math.max(Math.abs(pt.x - prev.p1.x), Math.abs(pt.y - prev.p1.y));
            const sx = pt.x >= prev.p1.x ? 1 : -1;
            const sy = pt.y >= prev.p1.y ? 1 : -1;
            p2 = { x: prev.p1.x + sx * m, y: prev.p1.y + sy * m };
          }
          if(e.shiftKey && ["line","arrow","freehand"].includes(prev.kind)) {
            p2=Math.abs(pt.x-prev.p1.x)>=Math.abs(pt.y-prev.p1.y)?{x:pt.x,y:prev.p1.y}:{x:prev.p1.x,y:pt.y};
          }
          if(prev.kind==="freehand"){
            const samples=strokeSamples.current.splice(0);
            const points=e.shiftKey?[prev.p1,p2]:[...(prev.points??[prev.p1]),...samples];
            const tail=points[points.length-1];
            if(!tail||tail.x!==p2.x||tail.y!==p2.y)points.push(p2);
            const result={...prev,p2,points,straightPrefix:e.shiftKey?1:prev.straightPrefix};draftRef.current=result;return result;
          }
          const result={ ...prev, p2 };draftRef.current=result;return result;
        };
        const result=update(draftRef.current);draftRef.current=result;setDraft(result);
        return;
      }
      if (d.mode === "shapeMove") {
        const dx = pt.x - d.grab.x;
        const dy = pt.y - d.grab.y;
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== d.id) return s;
            const p1 = { x: d.orig.p1.x + dx, y: d.orig.p1.y + dy };
            const p2 =
              d.orig.kind === "text" ? p1 : { x: d.orig.p2.x + dx, y: d.orig.p2.y + dy };
            return { ...s, p1, p2,...(d.orig.kind==="freehand"?{points:d.orig.points?.map(p=>({x:p.x+dx,y:p.y+dy}))}:{}) };
          }),
        );
        return;
      }
      if (d.mode === "shapePoint") {
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== d.id) return s;
            let target=pt;
            const fixed=d.point===1?d.orig.p2:d.orig.p1;
            if(e.shiftKey&&["line","arrow"].includes(s.kind))target=Math.abs(pt.x-fixed.x)>=Math.abs(pt.y-fixed.y)?{x:pt.x,y:fixed.y}:{x:fixed.x,y:pt.y};
            if(s.kind==="square"||s.kind==="circle"){const side=Math.max(Math.abs(pt.x-fixed.x),Math.abs(pt.y-fixed.y));target={x:fixed.x+(pt.x>=fixed.x?1:-1)*side,y:fixed.y+(pt.y>=fixed.y?1:-1)*side};}
            return d.point === 1
              ? s.kind === "text"
                ? { ...s, p1: target, p2: target }
                : { ...s, p1: target }
              : { ...s, p2: target };
          }),
        );
      }
    };

    let pending:PointerEvent|null=null;
    const queueMove=(e:PointerEvent)=>{
      pending=e;
      if(dragRef.current?.mode==="draw"&&draftRef.current?.kind==="freehand"&&!e.shiftKey){
        const samples=e.getCoalescedEvents?.()??[];
        for(const point of samples.length?samples:[e])strokeSamples.current.push({x:point.clientX,y:point.clientY});
      }
      if(!pointerRafRef.current)pointerRafRef.current=requestAnimationFrame(()=>{
        pointerRafRef.current=0;const next=pending;pending=null;if(next)onMove(next);
      });
    };
    const onUp = (e: PointerEvent) => {
      if(pending){cancelAnimationFrame(pointerRafRef.current);pointerRafRef.current=0;onMove(pending);pending=null;}
      const d = dragRef.current;
      if (!d) return;
      if(d.mode==="draw")onMove(e);
      dragRef.current = null;
      if (d.mode === "new") {
        setSelecting(false);
        // Use the release coordinates even if React has not committed the last move.
        const manual = d.manual || Math.hypot(e.clientX-d.start.x, e.clientY-d.start.y) > 4;
        const raw = manual ? rectFrom(d.start, { x:e.clientX, y:e.clientY }) : d.proposed;
        const s = raw ? { x:Math.max(0,raw.x), y:Math.max(0,raw.y),
          w:Math.max(0,Math.min(vpRef.current.w,raw.x+raw.w)-Math.max(0,raw.x)),
          h:Math.max(0,Math.min(vpRef.current.h,raw.y+raw.h)-Math.max(0,raw.y)) } : null;
        if (!s || s.w <= 0 || s.h <= 0 || (manual && (s.w < MIN_SEL || s.h < MIN_SEL))) {
          setSel(null);
          selRef.current = null;
          return;
        }
        selRef.current = s; setSel(s);
        setReleasePoint({x:e.clientX,y:e.clientY});
        // Пресет: действие выполняется сразу после рисования новой рамки
        // (перемещение/ресайз существующей не считается).
        const preset = infoRef.current?.preset;
        if (preset) void runPresetActionRef.current?.(preset);
        return;
      }
      if (d.mode === "draw") {
        const dr = draftRef.current;
        setDraft(null);
        if (dr && (dr.kind==="freehand" || Math.hypot(dr.p2.x - dr.p1.x, dr.p2.y - dr.p1.y) >= 3)) {
          setShapes((prev) => [...prev, dr]);
          setSelectedId(dr.id);
        }
      }
      scene.finish();
      pinLayoutRequest.current.run?.();
    };

    window.addEventListener("pointermove", queueMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", queueMove);
      window.removeEventListener("pointerup", onUp);
      cancelAnimationFrame(pointerRafRef.current);
    };
  }, []);

  // ------------------------------------------------------------------
  // Удержание «Сохранить» → меню быстрых мест; отпуск — выбор пункта
  // ------------------------------------------------------------------

  useEffect(() => {
    const finishHold = (e: PointerEvent) => {
      const h = holdRef.current;
      if (!h) return;
      holdRef.current = null;
      if (h.fired) {
        setQuickOpen(false);
        setHoverQuick(null);
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-quick-idx]");
        const idx = el ? Number((el as HTMLElement).dataset.quickIdx ?? "-1") : -1;
        const loc = cfgRef.current?.screenshotQuickLocations?.[idx];
        if (loc && loc.path) void saveQuickRef.current?.(loc);
        return;
      }
      window.clearTimeout(h.timer);
      // Отпустили быстро: обычный клик обработает onClick кнопки.
    };
    const onCancel = () => {
      const h = holdRef.current;
      if (!h) return;
      holdRef.current = null;
      window.clearTimeout(h.timer);
      setQuickOpen(false);
      setHoverQuick(null);
    };
    window.addEventListener("pointerup", finishHold);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", finishHold);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  const onSavePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || busy) return;
    suppressClickRef.current=false;quickHover.cancel();
    const h = { timer: 0, fired: false };
    holdRef.current = h;
    h.timer = window.setTimeout(() => {
      h.fired = true;
      suppressClickRef.current = true;
      setQuickOpen(true);
      setHoverQuick(cfgRef.current?.screenshotQuickLocations?.length ? 0 : null);
    }, HOLD_MS);
  };

  const onSaveClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    void saveWithDialog(info?.preset);
  };

  // ------------------------------------------------------------------
  // Клавиатура
  // ------------------------------------------------------------------

  const keyActions=useRef({copy:runCopy,save:saveWithDialog,pin:runPin,ocr:runOcr,sum:runSum,ai:runAiAgent,video:startVideo});
  keyActions.current={copy:runCopy,save:saveWithDialog,pin:runPin,ocr:runOcr,sum:runSum,ai:runAiAgent,video:startVideo};

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const text = textToolRef.current;
      const target = e.target as HTMLElement;
      // Text keeps its native keyboard editing. Escape on property controls
      // (checkbox/range/number) still cancels the current editor/tool/capture.
      if (target.closest("textarea, [contenteditable=true]") ||
          (e.key !== "Escape" && target.closest("input, select, .snip-select"))) return;
      if (pinEditorRef.current && busyRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (text.cancel()) return;
        if (dragRef.current) {
          dragRef.current = null; strokeSamples.current=[]; draftRef.current=null;
          setSelecting(false);
          scene.cancel(); setDraft(null); setSel(dragSelectionBeforeRef.current);
          return;
        }
        if (selectedIdRef.current != null) { setSelectedId(null); return; }
        if (toolRef.current) { setTool(null); return; }
        closeCapture(); return;
      }
      if (text.editRef.current) return;
      if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&(e.code==="Minus"||e.code==="Equal"||e.code==="NumpadSubtract"||e.code==="NumpadAdd")){
        e.preventDefault();void historyNavigation.current(e.code==="Minus"||e.code==="NumpadSubtract"?1:-1);return;
      }
      if(e.key==="Shift"&&["draw","shapePoint"].includes(dragRef.current?.mode??"")&&lastGesturePoint.current){
        const p=lastGesturePoint.current;window.dispatchEvent(new PointerEvent("pointermove",{clientX:p.x,clientY:p.y,shiftKey:true}));return;
      }
      if(busyRef.current)return;
      if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.code==="KeyV"&&!e.repeat&&selRef.current&&!dragRef.current&&!pinEditorRef.current&&!busyRef.current){e.preventDefault();void keyActions.current.video();return;}
      if(infoRef.current?.videoSelection&&selRef.current&&!dragRef.current){
        if(e.key==="Enter"){e.preventDefault();if(!e.repeat)void recordingAction.current();return;}
        if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;
      }
      if(!pinEditorRef.current&&!dragRef.current&&!text.gestureRef.current&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.code==="KeyA"){
        e.preventDefault();
        const inf=infoRef.current;
        if(!e.repeat&&inf&&imgRef.current?.complete){
          const point=pointerRef.current??{x:vpRef.current.w/2,y:vpRef.current.h/2};
          setSel(monitorRect(inf.monitors??[],point,inf,vpRef.current));
          setReleasePoint(point);setSelectedId(null);setSelecting(false);
          if(inf.preset)void runPresetActionRef.current?.(inf.preset);
        }
        return;
      }
      if(selRef.current&&!dragRef.current&&!text.gestureRef.current){
        if(matchesAction(e,cfgRef.current,"copy")){e.preventDefault();void keyActions.current.copy();return;}
        if(matchesAction(e,cfgRef.current,"save")){e.preventDefault();void keyActions.current.save();return;}
        if(matchesAction(e,cfgRef.current,"pin")&&!pinEditorRef.current){e.preventDefault();void keyActions.current.pin();return;}
        if(!e.ctrlKey&&!e.metaKey&&!e.altKey){

          const kinds:ShapeKind[]=["arrow","line","rect","freehand","text"];
          const digit=Number(/^(?:Digit|Numpad)([1-8])$/.exec(e.code)?.[1]);
          if(digit>=1&&digit<=5){e.preventDefault();if(!e.repeat){setTool(kinds[digit-1]!);setSelectedId(null);}return;}
          if(digit>=6&&digit<=8&&!pinEditorRef.current){e.preventDefault();if(!e.repeat){
            if(digit===6)void keyActions.current.ocr({closeOnSuccess:true});
            else if(digit===7)void keyActions.current.sum();else void keyActions.current.ai();
          }return;}
        }
      }
      if(!pinEditorRef.current&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key.startsWith("Arrow")){
        e.preventDefault();
        const dx=e.key==="ArrowLeft"?-1:e.key==="ArrowRight"?1:0,dy=e.key==="ArrowUp"?-1:e.key==="ArrowDown"?1:0;
        if(!demo)void invoke<Pt>("snipcast_capture_move_cursor",{dx,dy}).catch(err=>showToast("error",String(err)));
        return;
      }
      if ((!selRef.current || dragRef.current?.mode === "new") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "Tab") {
          e.preventDefault();
          if (!dragRef.current && !e.repeat) setDetectionMode(prev => prev === "element" ? "window" : "element");
          return;
        }
        if (e.key === "Shift") {
          e.preventDefault();
          if (!e.repeat) setColorFormat(prev => prev === "hex" ? "rgb" : "hex");
          return;
        }
        if (e.code === "KeyC" && !e.repeat && sampleRef.current) {
          e.preventDefault();
          const pixel = sampleRef.current;
          const value = formatPixel(pixel.r,pixel.g,pixel.b,assistRef.current.format);
          const write = demo ? navigator.clipboard.writeText(value) : invoke("snipcast_clipboard_write_text", { text:value });
          void write.then(() => showToast("ok",`Скопировано: ${value}`)).catch(() => showToast("error","Не удалось скопировать цвет"));
          return;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        if(dragRef.current||text.gestureRef.current||e.altKey)return;
        // e.key зависит от раскладки (на русской Ctrl+Z даёт «я»), поэтому
        // хоткей определяем по физической клавише e.code, с фолбэком на e.key.
        const lower = e.key.toLowerCase();
        const undoKey = e.code === "KeyZ" || lower === "z";
        if (undoKey) {
          e.preventDefault();
          scene.undo(e.shiftKey);
          if (!scene.ref.current.some((s) => s.id === selectedIdRef.current)) setSelectedId(null);
          return;
        }
      }
      const id = selectedIdRef.current;
      const sh = scene.ref.current.find((s) => s.id === id);
      if (!sh) return;
      if (e.key === "Enter" && sh.kind === "text") { e.preventDefault(); text.open(sh); return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault(); scene.change((prev) => prev.filter((s) => s.id !== id)); setSelectedId(null); return;
      }
      if (sh.kind === "text" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        const amount = e.shiftKey ? 10 : 1;
        const p1 = { x: sh.p1.x + (e.key === "ArrowRight" ? amount : e.key === "ArrowLeft" ? -amount : 0),
          y: sh.p1.y + (e.key === "ArrowDown" ? amount : e.key === "ArrowUp" ? -amount : 0) };
        scene.change((prev) => prev.map((s) => s.id === id ? { ...s, p1, p2: p1 } : s));
      }
    };
    window.addEventListener("keydown", onKey, true);
    const onKeyUp=(e:KeyboardEvent)=>{
      if(e.key==="Shift"&&["draw","shapePoint"].includes(dragRef.current?.mode??"")&&draftRef.current?.kind!=="freehand"&&lastGesturePoint.current){const p=lastGesturePoint.current;
        window.dispatchEvent(new PointerEvent("pointermove",{clientX:p.x,clientY:p.y,shiftKey:false}));}
    };
    window.addEventListener("keyup",onKeyUp,true);
    return () => {window.removeEventListener("keydown", onKey, true);window.removeEventListener("keyup",onKeyUp,true);};
  }, [closeCapture, scene.cancel, scene.change, scene.undo]);

  // ------------------------------------------------------------------
  // Отрисовка фигур на canvas-оверлее
  // ------------------------------------------------------------------

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const { w, h } = vp;
    const kw = pinEditor ? window.devicePixelRatio || 1 : k || 1;
    const pixelW=Math.max(1,Math.round(w*kw)),pixelH=Math.max(1,Math.round(h*kw));
    if(cvs.width!==pixelW)cvs.width=pixelW;
    if(cvs.height!==pixelH)cvs.height=pixelH;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(kw, 0, 0, kw, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Редактируемый текст прячем: инлайн-редактор занимает его место —
    // иначе видна «копия» и правка выглядит дублированием.
    const editingId = edit?.shape.id ?? null;
    const visible = (s: Shape) => !(editingId != null && s.id === editingId);
    // Фигуры живут только внутри выделения (как в Snipaste); исключение —
    // момент растягивания новой рамки, чтобы клип не прыгал под курсором.
    for (const s of shapes) if (visible(s)) drawShape(ctx, s, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, k, vp, edit?.shape.id]);

  // A live stroke has its own temporary layer; committed shapes stay untouched.
  useEffect(()=>{
    const cvs=draftCanvasRef.current;if(!cvs||!draft)return;
    const kw=pinEditor?window.devicePixelRatio||1:k||1;
    const width=Math.max(1,Math.round(vp.w*kw)),height=Math.max(1,Math.round(vp.h*kw));
    if(cvs.width!==width)cvs.width=width;if(cvs.height!==height)cvs.height=height;
    const ctx=cvs.getContext("2d");if(!ctx)return;
    ctx.setTransform(kw,0,0,kw,0,0);ctx.clearRect(0,0,vp.w,vp.h);drawShape(ctx,draft,1);
    cvs.style.clipPath=canvasRef.current?.style.clipPath??"none";
  },[draft,k,vp,!!pinEditor]);

  useLayoutEffect(()=>{
    const cvs=canvasRef.current;if(!cvs)return;
    cvs.style.clipPath=sel&&!selecting?`inset(${sel.y}px ${Math.max(0,vp.w-sel.x-sel.w)}px ${Math.max(0,vp.h-sel.y-sel.h)}px ${sel.x}px)`:"none";
  },[sel,selecting,vp]);

  // Рамка выбранной фигуры: ключевые точки
  const selectedShape = shapes.find((s) => s.id === selectedId) ?? null;
  const isTextContext = !!edit || selectedShape?.kind === "text" || tool === "text";
  const contextTool = tool ?? selectedShape?.kind;
  const optsTool = isTextContext ? "text" : contextTool && ["rect","square","circle","ellipse"].includes(contextTool) ? "rect" : contextTool;
  const activeShapeKind = selectedShape && ["rect","square","circle","ellipse"].includes(selectedShape.kind) ? selectedShape.kind : shapeKind;
  const applyShapeKind = (kind: Extract<ShapeKind,"rect"|"square"|"circle"|"ellipse">) => {
    setShapeKind(kind);
    if (!selectedShape || !["rect","square","circle","ellipse"].includes(selectedShape.kind) || selectedShape.kind === kind) return;
    scene.change(prev => prev.map(shape => {
      if (shape.id !== selectedShape.id || shape.kind === "text") return shape;
      if (kind === "circle" || kind === "square") {
        const box = shapeBounds(shape), side = Math.max(box.w, box.h);
        const p1 = {x:box.x+(box.w-side)/2,y:box.y+(box.h-side)/2};
        return {...shape,kind,p1,p2:{x:p1.x+side,y:p1.y+side}};
      }
      return {...shape,kind};
    }));
  };

  // Измерение панели инструментов для позиционирования
  useLayoutEffect(() => {
    const el = tbRef.current;
    if (!el) return;
    const measure=()=>setTbSize(prev=>prev?.w===el.offsetWidth && prev?.h===el.offsetHeight?prev:{w:el.offsetWidth,h:el.offsetHeight});
    measure();const observer=new ResizeObserver(measure);observer.observe(el);
    return ()=>observer.disconnect();
  }, [sel != null, selecting, !!pinEditor]);

  const place = (() => {
    if (!sel || selecting) return null;
    // До первого измерения — оценка, чтобы панель успела отрендериться и измериться
    const size = tbSize ?? { w: 700, h: 58 };
    const dpr=window.devicePixelRatio||1;
    const raw=pinEditor?.panelBounds;
    const bounds=raw?{x:raw.x/dpr,y:raw.y/dpr,w:raw.width/dpr,h:raw.height/dpr}:
      info?monitorRect(info.monitors??[],releasePoint??{x:sel.x+sel.w/2,y:sel.y+sel.h/2},info,vp):{x:0,y:0,...vp};
    const margin = 8;
    let left = sel.x + sel.w / 2 - size.w / 2;
    left = Math.max(bounds.x+margin, Math.min(left, bounds.x+bounds.w - size.w - margin));
    const reserve=optsTool?optsSize.h+margin:0;
    const height=size.h+reserve;
    const below=bounds.y+bounds.h-margin-(sel.y+sel.h+margin);
    const above=sel.y-margin-(bounds.y+margin);
    const side=below>=height?"below":above>=height||above>below?"above":"below";
    const desired=side==="below"?sel.y+sel.h+margin:sel.y-margin-height;
    const start=Math.max(bounds.y+margin,Math.min(desired,bounds.y+bounds.h-height-margin));
    const top=start+(side==="above"?reserve:0);
    return { left, top, side, right: vp.w - (left + size.w), bottom: top + size.h,bounds };
  })();

  const theme = cfg ? resolveUiTheme(normalizeUiTheme(cfg.theme)) : "dark";

  const quickLocs = cfg?.screenshotQuickLocations ?? [];
  const optsRef=useRef<HTMLDivElement>(null);
  const anchorKind=optsTool&&["square","circle","ellipse"].includes(optsTool)?"rect":optsTool;
  const button=anchorKind?tbRef.current?.querySelector<HTMLElement>(`[data-tool-anchor="${anchorKind}"]`):null;
  const anchor=button?.getBoundingClientRect();
  const optsPlace=place?{left:Math.max(place.bounds.x+8,Math.min((anchor?anchor.x+anchor.width/2:place.left+30)-optsSize.w/2,place.bounds.x+place.bounds.w-optsSize.w-8)),
    top:place.side==="below"?place.bottom+8:place.top-optsSize.h-8}:null;
  const pinLayoutRequest=useRef({busy:false,again:false,run:null as (()=>void)|null,lastKey:""});
  useEffect(()=>{
    if(!pinEditor||demo||pinEditor.sessionId==null)return;
    const sessionId=pinEditor.sessionId,revision=pinEditor.revision??0;
    let cancelled=false;
    void waitForPinPaint(imgRef.current).then(()=>{
      if(!cancelled)return invoke("snipcast_pin_present",{sessionId,revision});
    }).catch(e=>{if(!cancelled)showToast("error",String(e));});
    return()=>{cancelled=true;};
  },[pinEditor?.sessionId,pinEditor?.revision,demo]);
  useLayoutEffect(()=>{
    const el=optsRef.current;
    if(!el){setOptsSize(prev=>prev.h?{w:0,h:0}:prev);return;}
    const measure=()=>setOptsSize(prev=>prev.w===el.offsetWidth&&prev.h===el.offsetHeight?prev:{w:el.offsetWidth,h:el.offsetHeight});
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();
  },[optsTool]);
  useLayoutEffect(()=>{
    if(optsRef.current&&place){
      const el=optsRef.current,r=el.getBoundingClientRect(),b=place.bounds;
      el.style.right="auto";
      const anchor=anchorKind?tbRef.current?.querySelector<HTMLElement>(`[data-tool-anchor="${anchorKind}"]`)?.getBoundingClientRect():null;
      el.style.left=`${Math.max(b.x+8,Math.min((anchor?anchor.x+anchor.width/2:place.left+30)-r.width/2,b.x+b.w-r.width-8))}px`;
      el.style.top=`${place.side==="below"?place.bottom+8:place.top-r.height-8}px`;
    }
    if(!pinEditor||demo||pinEditor.sessionId==null)return;
    const request=pinLayoutRequest.current;
    let frame=0;
    const flush=()=>{
      if(request.busy){request.again=true;return;}
      if(dragRef.current||textToolRef.current.gestureRef.current){request.again=true;return;}
      const target=pinEditorRef.current;if(target?.sessionId==null)return;
      const dpr=window.devicePixelRatio||1;
      const rects=[tbRef.current,optsRef.current,...Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".capture__toast,.capture__quick,.capture__text-edit-wrap")??[])]
        .filter(el=>!!el).map(el=>{
          const r=el!.getBoundingClientRect();
          // Include the full CSS shadow, not only the panel's border box.
          const shadow=el!.matches(".capture__toolbar,.capture__opts,.capture__toast,.capture__quick");
          const side=shadow?40:12,top=shadow?30:12,bottom=shadow?50:12;
          return {x:Math.floor((r.x-side)*dpr),y:Math.floor((r.y-top)*dpr),width:Math.ceil((r.width+side*2)*dpr),height:Math.ceil((r.height+top+bottom)*dpr)};
        });
      const args={rects,sessionId:target.sessionId,revision:target.revision??0},key=JSON.stringify(args);
      if(request.lastKey===key)return;
      request.lastKey=key;request.busy=true;
      void invoke<PinEditGeometry|null>("snipcast_pin_regions",args).then(geometry=>{
        if(geometry&&pinEditorRef.current?.sessionId===geometry.sessionId)pinEditorRef.current.onLayout?.(geometry);
      }).catch(e=>{request.lastKey="";showToast("error",String(e));}).finally(()=>{
        request.busy=false;if(request.again){request.again=false;request.run?.();}
      });
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;flush();});};
    request.run=schedule;schedule();
    const observer=new ResizeObserver(schedule);
    for(const el of [tbRef.current,optsRef.current,...Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".capture__quick,.capture__text-edit-wrap")??[])])if(el)observer.observe(el);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);if(request.run===schedule)request.run=null;};
  },[!!pinEditor,pinEditor?.revision,place?.left,place?.top,optsTool,optsSize,selectedId,toast?.text,quickOpen,vp,edit?.shape]);
  const activeColor = edit?.shape.color ?? selectedShape?.color ?? drawColor;
  const activeOpacity=edit?.shape.opacity??selectedShape?.opacity??drawOpacity;
  const activeFill=selectedShape&&selectedShape.kind!=="text"?(selectedShape.filled??false):drawFill;
  const applyOpacity=(opacity:number)=>{setDrawOpacity(opacity);
    if(textTool.editRef.current)textTool.update({opacity});
    else if(selectedShape)scene.change(prev=>prev.map(s=>s.id===selectedShape.id?{...s,opacity}:s));};
  const applyFill=(filled:boolean)=>{setDrawFill(filled);
    if(selectedShape&&["rect","square","ellipse","circle"].includes(selectedShape.kind))scene.change(prev=>prev.map(s=>s.id===selectedShape.id?{...s,filled}:s));};
  const activeSize = edit?.shape.fontSize ?? (selectedShape?.kind === "text" ? selectedShape.fontSize : textSize);
  const textBaseWidth=Math.max(1,sel?.w??pinRect?.w??vp.w);
  const sizePercent=activeSize/textBaseWidth*100;
  const textAppearance=edit?.shape??(selectedShape?.kind==="text"?selectedShape:null);
  const outlineEnabled=textAppearance?!!textAppearance.outlineWidth:textOutlineEnabled;
  const outlineColor=textAppearance?.outlineColor??textOutlineColor;
  const outlineWidth=textAppearance?.outlineWidth||textOutlineWidth;
  const applyTextAppearance=(patch:Partial<import("./shapes").TextShape>)=>{
    if(textTool.editRef.current)textTool.update(patch);
    else if(selectedShape?.kind==="text")scene.change(prev=>prev.map(s=>s.id===selectedShape.id&&s.kind==="text"?{...s,...patch}:s));
  };
  const applyColor = (color: string) => {
    setDrawColor(color);
    if (textTool.editRef.current) textTool.update({ color });
    else if (selectedShape) scene.change((prev) => prev.map((s) => s.id === selectedShape.id ? { ...s, color } : s));
  };
  const applyThickness = (v: number) => {
    setDrawThickness(v);
    if (selectedShape?.kind !== "text" && selectedShape)
      scene.change((prev) => prev.map((s) => s.id === selectedShape.id ? { ...s, thickness: v } : s));
  };
  const applyTextSize = (v: number) => {
    if (!Number.isFinite(v)) return;
    const fontSize = Math.max(8, Math.min(128, v*textBaseWidth/100));
    setTextSize(fontSize);
    if (textTool.editRef.current) textTool.update({ fontSize });
    else if (selectedShape?.kind === "text")
      scene.change((prev) => prev.map((s) => s.id === selectedShape.id ? { ...s, fontSize } : s));
  };

  const selectedBox = selectedShape ? shapeBounds(selectedShape) : null;
  const visibleRect = sel ?? suggestion;
  const dim = visibleRect
    ? { top: { top: 0, left: 0, width: vp.w, height: Math.max(0, visibleRect.y) },
        bottom: { top: visibleRect.y + visibleRect.h, left: 0, width: vp.w, height: Math.max(0, vp.h - visibleRect.y - visibleRect.h) },
        left: { top: visibleRect.y, left: 0, width: Math.max(0, visibleRect.x), height: visibleRect.h },
        right: { top: visibleRect.y, left: visibleRect.x + visibleRect.w, width: Math.max(0, vp.w - visibleRect.x - visibleRect.w), height: visibleRect.h } }
    : null;

  return (
    <div
      ref={rootRef}
      className={`capture${presented ? " capture--presented" : ""}${pinEditor ? " capture--pin-editor" : ""}`}
      data-capture-image={info?.imageName}
      data-capture-theme={theme}
      style={{ cursor: tool ? "crosshair" : hoverText ? "move" : undefined }}
      onPointerDown={onRootPointerDown}
      onPointerMove={(e) => {
        if(altHeldRef.current!==e.altKey){altHeldRef.current=e.altKey;setAltHeld(e.altKey);}
        textTool.onPointerMove(e);
        if (!(e.target as HTMLElement).closest(".capture__ui, .capture__text-edit-wrap")) {
          const pt = { x: e.clientX, y: e.clientY };
          const top = [...scene.ref.current].reverse().find((s) => hitTest(s, pt));
          setHoverText(top?.kind === "text");
        } else setHoverText(false);
      }}
      onPointerLeave={() => { setHoverText(false); if (!dragRef.current) { pointerRef.current = null; setPointer(null); sampleRef.current = null; } }}
      onPointerUp={e=>{textTool.onPointerUp(e);pinLayoutRequest.current.run?.();}}
      onPointerCancel={() => {
        if (textTool.gestureRef.current) textTool.cancel();
        else if (dragRef.current) {
          dragRef.current = null;
          setSelecting(false);
          scene.cancel(); setDraft(null); setSel(dragSelectionBeforeRef.current);
        }
      }}
      onLostPointerCapture={() => { if (textTool.gestureRef.current) textTool.cancel(); }}
      onDoubleClick={onRootDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        closeCapture();
      }}
    >
      {imgUrl ? (
        <img
          ref={imgRef}
          className="capture__shot"
          style={pinRect||sourcePlacement ? {left:(pinRect??sourcePlacement)!.x,top:(pinRect??sourcePlacement)!.y,width:(pinRect??sourcePlacement)!.w,height:(pinRect??sourcePlacement)!.h,right:"auto",bottom:"auto"} : undefined}
          src={imgUrl}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget;
            if (!pinEditor) {
              const source = document.createElement("canvas");
              source.width = el.naturalWidth; source.height = el.naturalHeight;
              const context = source.getContext("2d", { willReadFrequently:true });
              if (context) { context.drawImage(el,0,0); setPixelSource(source); }
            }
            if (el.naturalWidth > 0 && el.clientWidth > 0) {
              setK(el.naturalWidth / el.clientWidth);
            }
            // onLoad only means decoded, not painted. Keep the window
            // transparent until the native show event, and reject stale loads.
            const label = readySignalRef.current;
            if (label) {
              readySignalRef.current = null;
              const seq = presentationSeqRef.current;
              const imageName = infoRef.current?.imageName;
              void (async () => {
                await el.decode();
                await shownListenerRef.current;
                await waitForCapturePaint();
                if (seq !== presentationSeqRef.current || imgRef.current !== el || !el.isConnected) return;
                presentableImageRef.current = imageName ?? null;
                await invoke("snipcast_capture_ready", { label, imageName });
              })().catch((err) => console.error("[Snipcast] capture_ready:", err));
            }
          }}
        />
      ) : (
        <div className="capture__placeholder" />
      )}

      {/* Затемнение вне выделения */}
      {!pinEditor && dim ? (
        <>
          <div className="capture__dim capture__dim--selection" style={dim.top} />
          <div className="capture__dim capture__dim--selection" style={dim.bottom} />
          <div className="capture__dim capture__dim--selection" style={dim.left} />
          <div className="capture__dim capture__dim--selection" style={dim.right} />
          <div className="capture__selection-reveal"
            style={{ left: visibleRect!.x, top: visibleRect!.y, width: visibleRect!.w, height: visibleRect!.h }} />
        </>
      ) : (
        pinEditor ? null : <div className="capture__dim capture__dim--full" />
      )}

      {altHeld&&!info?.videoSelection&&(sel||pointer)?<svg className="capture__guides" width={vp.w} height={vp.h} aria-hidden>
        {sel?<path style={{strokeWidth:1/k,strokeDasharray:`${8/k} ${6/k}`}} d={`M ${sel.x+sel.w/2} 0 V ${vp.h} M 0 ${sel.y+sel.h/2} H ${vp.w}`} />:null}
        {pointer?<path className="capture__cursor-guides" style={{strokeWidth:1/k}} d={`M ${pointer.x} 0 V ${vp.h} M 0 ${pointer.y} H ${vp.w}`} />:null}
      </svg>:null}
      <canvas ref={canvasRef} className="capture__shapes" />
      {draft?<canvas ref={draftCanvasRef} className="capture__shapes capture__shapes--draft" />:null}

      {/* Рамка выделения + маркеры + чип размеров */}
      {visibleRect ? (
        <>
          <div
            className={`capture__frame${!sel || selecting ? " capture__frame--proposed" : ""}`}
            style={{ left: visibleRect.x, top: visibleRect.y, width: visibleRect.w, height: visibleRect.h }}
          >
            {sel && !selecting && !pinEditor ? HANDLES.map((h) => (
              <div key={h} data-handle={h} className={`capture__handle capture__handle--${h}`} />
            )) : null}
          </div>
          <div
            className="capture__dimchip"
            style={{ left: visibleRect.x, top: visibleRect.y >= 36 ? visibleRect.y - 32 : visibleRect.y + 6 }}
          >
            {Math.round(visibleRect.w * k)} × {Math.round(visibleRect.h * k)}{historyPosition>=0?` · История ${historyPosition+1}/${historyCount}`:""}
          </div>
        </>
      ) : null}

      {!pinEditor && !sel && !selecting ? (
        <>
          <div className="capture__hint capture__hint--top">Выберите область...</div>
          {info?.preset ? (
            <div className="capture__preset-chip">Пресет: {info.preset.title}</div>
          ) : null}
        </>
      ) : null}

      {(!sel || selecting) && pointer && pixelSource && info ? <CaptureLoupe
        source={pixelSource} pointer={pointer} info={info} viewport={vp} format={colorFormat} onSample={onPixelSample} /> : null}
      {!pinEditor?<CaptureShortcuts info={info} viewport={vp} session={sessionSeq} cursor={pointerRef} motion={hintMotion}
        actionKeys={{save:actionHotkeyLabel(cfg,"save"),pin:actionHotkeyLabel(cfg,"pin"),copy:actionHotkeyLabel(cfg,"copy")}} selected={!!sel} gesture={dragRef.current?.mode??(textTool.frame?"text":undefined)} editing={!!edit}
        selectedShape={selectedId!=null} tool={tool} mode={detectionMode}/>:null}

      {/* Выбранная фигура: габарит + ключевые точки (точки — в координатах окна) */}
      {selectedShape && selectedShape.kind !== "text" && selectedBox ? (
        <>
          <div
            key={`shape-box-${selectedShape.id}`}
            className="capture__shape-box"
            style={{
              left: selectedBox.x - 5,
              top: selectedBox.y - 5,
              width: selectedBox.w + 10,
              height: selectedBox.h + 10,
            }}
          />
          {selectedShape.kind!=="freehand" ? <>
          <div key={`shape-kp1-${selectedShape.id}`} className="capture__kp" data-kp="1" style={{ left: selectedShape.p1.x, top: selectedShape.p1.y }} />
          <div key={`shape-kp2-${selectedShape.id}`} className="capture__kp" data-kp="2" style={{ left: selectedShape.p2.x, top: selectedShape.p2.y }} />
          </> : null}

        </>
      ) : null}

      {selectedShape?.kind === "text" && !edit ? <TextFrame key={selectedShape.id} shape={selectedShape} tool={textTool} /> : null}
      {textTool.frame ? <div className="capture__text-frame" style={{ left: textTool.frame.x,
        top: textTool.frame.y, width: textTool.frame.w, height: textTool.frame.h }} /> : null}
      <TextEditor tool={textTool} />

      {/* Панель инструментов, опции инструмента, меню быстрых мест, тост */}
      <div className="capture__ui">
        {sel && place ? (
          <div ref={tbRef} className="capture__toolbar" style={{ left: place.left, top: place.top,maxWidth:place.bounds.w-16,flexWrap:"wrap" }}>
              {(
                [
                  { kind: "arrow" as const, label: "Стрелка", title: "Нарисовать стрелку", icon: <IconArrow /> },
                  { kind: "line" as const, label: "Линия", title: "Нарисовать линию", icon: <IconLine /> },
                  { kind: "rect" as const, label: "Фигура", title: "Нарисовать фигуру", icon: <IconRect /> },
                  { kind:"freehand" as const,label:"Рисование",title:"Свободное рисование",icon:<SvgIcon><path d="M4 16c4-14 3 7 8-5s1 10 8-3" fill="none" stroke="currentColor" strokeWidth="1.8"/></SvgIcon> },
                  { kind: "text" as const, label: "Текст", title: "Добавить текст", icon: <IconText /> },
                ] as const
            ).filter(()=>!info?.videoSelection).map((t,i) => (
              <button
                key={t.kind}
                type="button"
                title={`${t.title} (${i+1})`}
                disabled={busy}
                data-tool-anchor={t.kind} className={`capture__btn${tool === t.kind ? " is-active" : ""}`}
                onClick={() => { textTool.commit(); setSelectedId(null); setTool((prev) => (prev === t.kind ? null : t.kind)); }}
              >
                {t.icon}
                <span>{t.label}</span><kbd className="capture__tool-key">{i+1}</kbd>
              </button>
            ))}

            {!info?.videoSelection&&(shapes.length>0||!!edit?.shape.text.trim())?<button
              type="button" className="capture__btn" title="Удалить все фигуры и текст" disabled={busy}
              onPointerDown={e=>e.preventDefault()}
              onClick={()=>{textTool.commit();scene.change([]);setSelectedId(null);setTool(null);}}
            ><SvgIcon><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon><span>Очистить</span></button>:null}

            {!info?.videoSelection?<span className="capture__toolbar-sep" aria-hidden />:null}

            {pinEditor ? <>
              <button type="button" title="Сохранить как файл" className="capture__btn" disabled={busy} onPointerEnter={quickHover.enter} onPointerLeave={quickHover.leave} onPointerDown={onSavePointerDown} onClick={onSaveClick}>
                <IconSave /><span>Сохранить</span>{actionHotkeyLabel(cfg,"save")?<kbd className="capture__tool-key">{actionHotkeyLabel(cfg,"save")}</kbd>:null}
              </button>
              <button type="button" className="capture__btn" disabled={busy} onClick={() => void applyPinAnnotations()} title="Применить аннотации к закрепу">
                <SvgIcon><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon><span>Готово</span>
              </button>
              <button type="button" className="capture__btn" disabled={busy} onClick={closeCapture} title="Отменить аннотирование">
                <SvgIcon><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></SvgIcon><span>Отмена</span>
              </button>
            </> : info?.videoSelection ? <>
              <div className="capture__video-config"><label>Плавность <ThemedSelect label="Частота кадров записи" value={String(videoFps)} disabled={busy} onChange={v=>setVideoFps(Number(v))} options={[{value:"15",label:"15 кадров/с"},{value:"30",label:"30 кадров/с"}]}/></label><label><input type="checkbox" checked={videoAudio} disabled={busy} onChange={e=>setVideoAudio(e.target.checked)}/>Звук системы</label></div>
              <button type="button" className="capture__btn is-active" disabled={busy} onClick={()=>void startVideo()} title="Начать запись области"><VideoIcon name="video"/><span>Записать</span>{actionHotkeyLabel(cfg,"save")?<kbd className="capture__tool-key">{actionHotkeyLabel(cfg,"save")}</kbd>:null}</button>
              <button type="button" className="capture__btn" disabled={busy} onClick={closeCapture}><VideoIcon name="close"/><span>Отмена</span><kbd className="capture__tool-key">Esc</kbd></button>
            </> : <>

            <button
              type="button"
              title="Распознать текст"
              className="capture__btn"
              disabled={busy}
              onClick={() => void runOcr({ closeOnSuccess: true })}
            >
              <IconOcr />
              <span>{ocrLoading ? "…" : "Распознать"}</span>
              <kbd className="capture__tool-key">6</kbd>
            </button>

            <button type="button" title="Сложить распознанные числа" className="capture__btn" disabled={busy} onClick={()=>void runSum()}>
              <SvgIcon><path d="M18 4H6l7 8-7 8h12" fill="none" stroke="currentColor" strokeWidth="1.8"/></SvgIcon><span>Сумма</span><kbd className="capture__tool-key">7</kbd>
            </button>
            <button
              type="button"
              title="Спросить ИИ по выделенной области"
              className="capture__btn"
              disabled={busy}
              onClick={() => void runAiAgent()}
            >
              <IconAi />
              <span>ИИ Агент</span>
              <kbd className="capture__tool-key">8</kbd>
            </button>

            <span className="capture__toolbar-sep" aria-hidden />

            <button type="button" title="Записать видео области (V)" className="capture__btn" disabled={busy} onClick={()=>void startVideo()}><VideoIcon name="video"/><span>Видео</span><kbd className="capture__tool-key">V</kbd></button>
            <button
              type="button"
              title="Сохранить как файл"
              className="capture__btn"
              disabled={busy}
              onPointerEnter={quickHover.enter} onPointerLeave={quickHover.leave} onPointerDown={onSavePointerDown}
              onClick={onSaveClick}
            >
              <IconSave />
              <span>Сохранить</span>
              {actionHotkeyLabel(cfg,"save")?<kbd className="capture__tool-key">{actionHotkeyLabel(cfg,"save")}</kbd>:null}
            </button>
            <button
              type="button"
              title="Закрепить на экране"
              className="capture__btn"
              disabled={busy}
              onClick={() => void runPin()}
            >
              <IconPin />
              <span>Закрепить</span>
              {actionHotkeyLabel(cfg,"pin")?<kbd className="capture__tool-key">{actionHotkeyLabel(cfg,"pin")}</kbd>:null}
            </button>
            </>}
            {!info?.videoSelection?<button
              type="button"
              title="Копировать в буфер обмена"
              className="capture__btn"
              disabled={busy}
              onClick={() => void runCopy()}
            >
              <IconCopy />
              <span>Копировать</span>
              {actionHotkeyLabel(cfg,"copy")?<kbd className="capture__tool-key">{actionHotkeyLabel(cfg,"copy")}</kbd>:null}
            </button>:null}
          </div>
        ) : null}

        {sel && place && optsTool ? (
          <div
            ref={optsRef}
            className="capture__opts"
            onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }}
            style={{...optsPlace,maxHeight:Math.max(40,place.bounds.h-(tbSize?.h??58)-32),boxSizing:"border-box",overflowY:"auto"}}
          >
            {optsTool === "rect" ? (
              <div className="capture__opts-shapes">
                {(
                  [
                    { kind: "rect" as const, label: "Прямоугольник", icon: <IconShapeRect /> },
                    { kind: "square" as const, label: "Квадрат", icon: <IconShapeSquare /> },
                    { kind: "circle" as const, label: "Круг", icon: <IconShapeCircle /> },
                    { kind: "ellipse" as const, label: "Овал", icon: <IconShapeEllipse /> },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.kind}
                    type="button"
                    title={f.label}
                    aria-label={f.label}
                    className={`capture__shape-btn${activeShapeKind === f.kind ? " is-active" : ""}`}
                    onClick={() => applyShapeKind(f.kind)}
                  >
                    {f.icon}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="capture__opts-swatches">
              {SWATCHES.map(c => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Цвет ${c}`}
                  className={`capture__swatch${activeColor === c ? " is-active" : ""}`}
                  style={{ background: c }}
                  onClick={() => applyColor(c)}
                />
              ))}
            </div>
            {optsTool&&["rect","square","ellipse","circle"].includes(optsTool)?<div className="capture__shape-variants capture__fill-modes" role="group" aria-label="Режим фигуры">
              {[{label:"Контур",filled:false},{label:"Заливка",filled:true}].map(option=><button key={option.label} type="button" aria-pressed={activeFill===option.filled}
                className={`capture__shape-btn${activeFill===option.filled?" is-active":""}`} onClick={()=>applyFill(option.filled)}>{option.label}</button>)}
            </div>:null}
            <label className="capture__opts-row"><span>Прозрачность</span><input type="range" aria-label="Прозрачность" min={0} max={100} step={1} value={Math.round((1-activeOpacity)*100)}
              onPointerDown={()=>{if(!edit)scene.begin();}} onPointerUp={()=>scene.finish()} onChange={e=>applyOpacity(1-Number(e.target.value)/100)}/><span className="capture__opts-value">{Math.round((1-activeOpacity)*100)}%</span></label>
            <label className="capture__opts-row">
              <span>Размер</span>
              <input type="range" aria-label={isTextContext ? "Размер текста" : "Толщина линии"}
                min={isTextContext ? 800/textBaseWidth : MIN_THICKNESS} max={isTextContext ? 12800/textBaseWidth : MAX_THICKNESS} step={isTextContext ? .1 : 1}
                value={isTextContext ? sizePercent : drawThickness}
                onPointerDown={() => { if (!edit) scene.begin(); }}
                onPointerUp={() => scene.finish()}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (isTextContext) applyTextSize(v); else applyThickness(v);
                }} />
              <span className="capture__opts-value">{isTextContext ? `${Number(sizePercent.toFixed(1))}%` : drawThickness}</span>
            </label>
            {isTextContext?<>
              <label className="capture__opts-row capture__outline-toggle"><input type="checkbox" aria-label="Обводка текста" checked={outlineEnabled}
                onChange={e=>{setTextOutlineEnabled(e.target.checked);applyTextAppearance({outlineWidth:e.target.checked?outlineWidth:0,outlineColor});}}/><span>Обводка</span></label>
              {outlineEnabled?<>
                <div className="capture__opts-swatches" aria-label="Цвет обводки">{SWATCHES.map(c=>
                  <button key={c} type="button" aria-label={`Цвет обводки ${c}`} className={`capture__swatch${outlineColor===c?" is-active":""}`} style={{background:c}}
                    onClick={()=>{setTextOutlineColor(c);applyTextAppearance({outlineColor:c});}}/>)}</div>
                <label className="capture__opts-row"><span>Толщина обводки</span><input type="range" aria-label="Толщина обводки" min={1} max={12} step={1} value={outlineWidth}
                  onPointerDown={()=>{if(!edit)scene.begin();}} onPointerUp={()=>scene.finish()}
                  onChange={e=>{const v=Number(e.target.value);setTextOutlineWidth(v);applyTextAppearance({outlineWidth:v});}}/><span className="capture__opts-value">{outlineWidth} px</span></label>
              </>:null}
            </>:null}
          </div>
        ) : null}

        {quickOpen && place ? (
          <div className="capture__quick" onPointerEnter={quickHover.menuEnter} onPointerLeave={quickHover.leave} style={{ right: place.right, top: place.bottom + 8 }}>
            {quickLocs.length > 0 ? (
              quickLocs.map((loc, i) => (
                <button
                  key={`${loc.path}-${i}`}
                  type="button"
                  data-quick-idx={i}
                  className={`capture__quick-item${hoverQuick === i ? " is-hover" : ""}`}
                  onClick={()=>{if(!holdRef.current)void saveToQuick(loc);}}
                  tabIndex={0}
                  onPointerDown={(e) => e.preventDefault()}
                >
                  <span className="capture__quick-name">{loc.name}</span>
                  <span className="capture__quick-path">{loc.path}</span>
                </button>
              ))
            ) : (
              <div className="capture__quick-item capture__quick-item--disabled">Места не настроены</div>
            )}
          </div>
        ) : null}

        {toast ? (
          <div className={`capture__toast capture__toast--${toast.kind}`} role="status"
            style={pinEditor&&sel?{left:sel.x+sel.w/2,top:Math.max(sel.y+8,sel.y+sel.h-64),bottom:"auto",maxWidth:400,whiteSpace:"normal"}:undefined}>
            <span className="capture__toast-icon" aria-hidden>
              {toast.kind === "ok" ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12l5 5 9-9"
                    stroke="#fff"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                "!"
              )}
            </span>
            <span className="capture__toast-text">{toast.text}</span>
          </div>
        ) : null}

        {loadError ? (
          <div className="capture__toast capture__toast--error" role="alert">
            <span className="capture__toast-icon" aria-hidden>
              !
            </span>
            <span className="capture__toast-text">Не удалось открыть снимок: {loadError}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
