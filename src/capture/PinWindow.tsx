import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { isDemoMode } from "./demo";
import { CaptureOverlay } from "./CaptureOverlay";
import { waitForPinPaint,type PinEditGeometry } from "./pinGeometry";
import { PinMenuWindow, type PinMenuAction } from "./PinMenuWindow";
import "../capture.css";

type PinInfo = {
  label: string;
  imageName: string;
  width: number;
  height: number;
  selected?:boolean;
  imageRect?:{x:number;y:number;width:number;height:number};
};

/** Граница/угол, за который тянут окно. */
type EdgeDir = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const EDGE_PX = 10; // полоса у краёв окна для растягивания
const MIN_SCALE = 0.15;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.1;
const DOUBLE_CLICK_MS = 500; // как двойной клик в Windows по умолчанию
const CLICK_SLOP_PX = 6; // курсор между кликами не должен уйти дальше этого

// Демо-режим: кадра из бэкенда нет, окно условное
const DEMO_SIZE = { w: 640, h: 400 };

const CORNERS: EdgeDir[] = ["nw", "ne", "se", "sw"];

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** Граница по позиции курсора в координатах окна (CSS px). */
function edgeAt(x: number, y: number): EdgeDir | null {
  const image=document.querySelector(".pin__shot")?.getBoundingClientRect();
  if(image){x-=image.x;y-=image.y;}
  const w=image?.width??window.innerWidth,h=image?.height??window.innerHeight;
  if(x < -4 || y < -4 || x>w+4 || y>h+4)return null;
  const left = x <= EDGE_PX;
  const right = x >= w - EDGE_PX;
  const top = y <= EDGE_PX;
  const bottom = y >= h - EDGE_PX;
  if (top && left) return "nw";
  if (top && right) return "ne";
  if (bottom && left) return "sw";
  if (bottom && right) return "se";
  if (top) return "n";
  if (bottom) return "s";
  if (left) return "w";
  if (right) return "e";
  return null;
}

/** Ручное пропорциональное растягивание за любую границу. */
type EdgeDrag = {
  dir: EdgeDir;
  /// Старт в ЭКРАННЫХ координатах: окно при растягивании само движется,
  /// и координаты относительно окна дают петлю обратной связи (окно
  /// «скачет» на месте при остановке курсора). Экранные — стабильны.
  startScreen: { x: number; y: number };
  origPos: { x: number; y: number };
  origSize: { w: number; h: number };
  frame: number;
  pending: { x: number; y: number; w: number; h: number } | null;
};

/**
 * Окно закрепа `pin-N`: снимок на всё окно.
 * Перетаскивание мышью и стрелками, колесо — масштаб (CSS-превью + одна
 * фиксация размера — без дёрганий и белых полей), растягивание за любую
 * границу/угол — пропорциональное.
 * Закрытие: двойной клик, средняя кнопка мыши, ПКМ → меню, Esc.
 */
export function PinWindow() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const demo = isDemoMode();

  const [url, setUrl] = useState<string | null>(null);
  const [edge, setEdge] = useState<EdgeDir | null>(null);
  const [annotationSource, setAnnotationSource] = useState<string | null>(null);
  const [demoMenu, setDemoMenu] = useState(false);
  const [error, setError] = useState("");
  const [selected,setSelected]=useState(true);
  const selectionRevisionRef=useRef(0);
  const selectedListenerRef=useRef<Promise<()=>void>|null>(null);
  const [pad,setPad]=useState(0);
  const padRef=useRef(0);
  const editingRef = useRef(false);
  const menuRef = useRef(false); menuRef.current = demoMenu;
  const urlRef = useRef(url); urlRef.current = url;
  const originalGeometryRef = useRef<PinEditGeometry | null>(null);
  const [editGeometry,setEditGeometry]=useState<PinEditGeometry|null>(null);
  const finishingRef=useRef(false);
  const [pinFrame,setPinFrame]=useState<{sessionId:number;revision:number}|null>(null);

  // Исходный размер кадра в физических px и текущий зафиксированный масштаб
  const origRef = useRef<{ w: number; h: number } | null>(demo ? DEMO_SIZE : null);
  const scaleRef = useRef(1);
  /** Масштаб, ожидающий применения в ближайшем кадре. */
  const pendingScaleRef = useRef<number | null>(null);
  const wheelFrameRef = useRef(0);
  const edgeDragRef = useRef<EdgeDrag | null>(null);
  // Ручной детект двойного клика: первый клик запускает startDragging() —
  // модальный цикл переноса съедает mouseup, и браузерный dblclick не
  // приходит. Считаем клики сами, по экранным координатам курсора: если
  // между нажатиями окно реально перетащили, координаты разойдутся.
  const lastPressRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const demoRef = useRef(demo);
  demoRef.current = demo;

  const beginAnnotation = useCallback(async () => {
    if (editingRef.current) return;
    if (!origRef.current || (!urlRef.current && !demoRef.current)) { setError("Снимок ещё загружается"); return; }
    editingRef.current = true; setDemoMenu(false); setError("");
    lastPressRef.current = null;
    if (wheelFrameRef.current) cancelAnimationFrame(wheelFrameRef.current);
    wheelFrameRef.current = 0; pendingScaleRef.current = null;
    if (edgeDragRef.current?.frame) cancelAnimationFrame(edgeDragRef.current.frame);
    edgeDragRef.current = null;
    try {
      let source = urlRef.current;
      if (demoRef.current) {
        if (!source) {
          const canvas = document.createElement("canvas");
          canvas.width = DEMO_SIZE.w; canvas.height = DEMO_SIZE.h;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#262632"; ctx.fillRect(0,0,canvas.width,canvas.height);
          source = canvas.toDataURL("image/png");
        }
      } else {
        originalGeometryRef.current = await invoke("snipcast_pin_begin_annotation");
        setEditGeometry(originalGeometryRef.current);
      }
      setAnnotationSource(source!);
    } catch (e) { editingRef.current = false; setError(String(e)); }
  }, []);

  const finishAnnotation = useCallback(async (png?: string) => {
    if(finishingRef.current)return;
    finishingRef.current=true;
    try {
      if (png) {
        if (!demoRef.current) await invoke("snipcast_pin_update", { png });
        setUrl(`data:image/png;base64,${png}`);
      }
      const geometry=originalGeometryRef.current;
      let waitingForFrame=false;
      if(!demoRef.current&&geometry){
        const revision=await invoke<number|null>("snipcast_pin_end_annotation",{sessionId:geometry.sessionId});
        if(revision!=null){waitingForFrame=true;setPinFrame({sessionId:geometry.sessionId,revision});}
      }
      originalGeometryRef.current=null;if(!waitingForFrame)editingRef.current=false;lastPressRef.current=null;
      setAnnotationSource(null);setEditGeometry(null);setEdge(null);
    }finally{finishingRef.current=false;}
  }, []);

  useEffect(()=>{
    if(!pinFrame||annotationSource)return;
    let cancelled=false;
    void waitForPinPaint(rootRef.current?.querySelector<HTMLImageElement>(".pin__shot")??null).then(async()=>{
      if(cancelled)return;
      try {await invoke("snipcast_pin_present",pinFrame);if(!cancelled){editingRef.current=false;setPinFrame(null);}}
      catch(e){if(!cancelled)setError(String(e));}
    });
    return()=>{cancelled=true;};
  },[pinFrame,annotationSource,url]);

  useEffect(() => {
    if (demo) return;
    const un = getCurrentWindow().listen("snipcast://pin-annotate", () => { void beginAnnotation(); });
    return () => { void un.then(f => f()); };
  }, [demo, beginAnnotation]);

  useEffect(()=>{
    if(demo)return;
    const un=getCurrentWindow().listen<boolean>("snipcast://pin-selected",e=>{selectionRevisionRef.current++;setSelected(e.payload);});
    selectedListenerRef.current=un;
    const resize=()=>setPad(padRef.current/(window.devicePixelRatio||1));
    window.addEventListener("resize",resize);
    return ()=>{void un.then(f=>f());window.removeEventListener("resize",resize);};
  },[demo]);

  const closePin = useCallback(() => {
    if (demoRef.current) {
      console.log("[demo] snipcast_pin_close (window.close)");
      return;
    }
    void getCurrentWindow()
      .close()
      .catch((e) => console.error("[Snipcast] close pin:", e));
  }, []);

  /** Сдвиг окна на dx/dy физических пикселей (стрелки, Shift — ×10). */
  const moveBy = useCallback(async (dx: number, dy: number) => {
    if (demoRef.current) {
      console.log(`[demo] snipcast_pin_move (${dx}, ${dy})`);
      return;
    }
    try {
      const pos = await getCurrentWindow().outerPosition();
      await getCurrentWindow().setPosition(new PhysicalPosition(pos.x + dx, pos.y + dy));
    } catch (e) {
      console.error("[Snipcast] move pin:", e);
    }
  }, []);

  const setSizePx = useCallback((w: number, h: number) => {
    if (demoRef.current) return;
    void getCurrentWindow()
      .setSize(new PhysicalSize(Math.max(16, Math.round(w))+padRef.current*2, Math.max(16, Math.round(h))+padRef.current*2))
      .catch((e) => console.error("[Snipcast] resize pin:", e));
  }, []);

  // Колесо: размер меняется сразу, но не чаще одного раза на кадр —
  // отклик мгновенный, без задержек и «скачков» превью.
  const zoomBy = useCallback(
    (step: number) => {
      const orig = origRef.current;
      if (!orig) return;
      const target = clamp((pendingScaleRef.current ?? scaleRef.current) * step, MIN_SCALE, MAX_SCALE);
      pendingScaleRef.current = target;
      if (!wheelFrameRef.current) {
        wheelFrameRef.current = window.requestAnimationFrame(() => {
          wheelFrameRef.current = 0;
          const t = pendingScaleRef.current;
          pendingScaleRef.current = null;
          if (t == null) return;
          scaleRef.current = t;
          setSizePx(orig.w * t, orig.h * t);
          if (demoRef.current) {
            console.log(`[demo] snipcast_pin_zoom → ${Math.round(orig.w * t)}×${Math.round(orig.h * t)}`);
          }
        });
      }
    },
    [setSizePx],
  );

  // Загрузка: инфо о закрепе + PNG-байты кадра
  useEffect(() => {
    if (demo) {
      setUrl(null);
      return;
    }
    let dead = false;
    let objectUrl: string | null = null;

    (async () => {
      try {
        await selectedListenerRef.current;
        const selectionRevision=selectionRevisionRef.current;
        const info = await invoke<PinInfo>("snipcast_pin_info");
        const buf = await invoke<ArrayBuffer>("snipcast_capture_image_data", {
          name: info.imageName,
        });
        objectUrl = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        if (dead) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        origRef.current = { w: info.width, h: info.height };
        padRef.current=info.imageRect?.x??0;setPad(padRef.current/(window.devicePixelRatio||1));
        if(selectionRevision===selectionRevisionRef.current)setSelected(info.selected??true);
        scaleRef.current = 1;
        setUrl(objectUrl);
      } catch (e) {
        console.error("[Snipcast] не удалось открыть закреп:", e);
      }
    })();

    return () => {
      dead = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [demo]);

  useEffect(()=>{
    if(demo||!url)return;
    let cancelled=false;
    void waitForPinPaint(rootRef.current?.querySelector<HTMLImageElement>(".pin__shot")??null).then(async()=>{
      if(cancelled)return;
      try{await invoke("snipcast_pin_ready");}
      catch(e){if(!cancelled)console.error("[Snipcast] не удалось показать закреп:",e);}
    });
    return()=>{cancelled=true;};
  },[demo,url]);

  // Клавиатура: стрелки двигают окно (Shift — ×10), Esc закрывает (сначала меню)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (menuRef.current) { setDemoMenu(false); return; }
        closePin();
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      void moveBy(dx, dy);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closePin, moveBy]);

  // Колесо — масштаб (нативный слушатель: React вешает wheel пассивно)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (editingRef.current || menuRef.current) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelFrameRef.current) window.cancelAnimationFrame(wheelFrameRef.current);
    };
  }, [zoomBy, !!annotationSource]);

  // Пропорциональное растягивание за любую границу: ведём указателем сами,
  // противоположная сторона стоит на месте; применяем не чаще кадра.
  // Слушаем pointermove: при захвате указателя (setPointerCapture) события
  // доставляются даже когда курсор УШЁЛ за пределы окна — без этого
  // растягивание наружу обрывалось на краю окна.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = edgeDragRef.current;
      if (!d) return;
      // Курсор даёт CSS-пиксели, размеры окна — физические: приводим к одним
      // единицам, иначе на масштабированном экране край отстаёт от курсора.
      const dpr = window.devicePixelRatio || 1;
      const dx = (e.screenX - d.startScreen.x) * dpr;
      const dy = (e.screenY - d.startScreen.y) * dpr;
      const sx = d.dir.includes("w") ? -1 : 1;
      const sy = d.dir.includes("n") ? -1 : 1;
      const proposedW = d.origSize.w + dx * sx;
      const proposedH = d.origSize.h + dy * sy;
      // Пропорция: угол — по большей из осей, граница — по своей оси.
      const k = clamp(
        CORNERS.includes(d.dir)
          ? Math.max(proposedW / d.origSize.w, proposedH / d.origSize.h)
          : d.dir === "n" || d.dir === "s"
            ? proposedH / d.origSize.h
            : proposedW / d.origSize.w,
        MIN_SCALE,
        MAX_SCALE,
      );
      const w = Math.max(16, Math.round(d.origSize.w * k));
      const h = Math.max(16, Math.round(d.origSize.h * k));
      const x = d.dir.includes("w") ? d.origPos.x + d.origSize.w - w : d.origPos.x;
      const y = d.dir.includes("n") ? d.origPos.y + d.origSize.h - h : d.origPos.y;
      d.pending = { x, y, w, h };
      if (!d.frame) {
        d.frame = window.requestAnimationFrame(() => {
          const drag = edgeDragRef.current;
          if (!drag) return;
          drag.frame = 0;
          const p = drag.pending;
          drag.pending = null;
          if (!p) return;
          if (demoRef.current) {
            console.log(`[demo] snipcast_pin_resize ${p.w}×${p.h}`);
            return;
          }
          console.log(`[Snipcast] pin resize ${drag.dir} → ${p.w}×${p.h} @ (${p.x},${p.y})`);
          const win = getCurrentWindow();
          void win.setSize(new PhysicalSize(p.w+padRef.current*2, p.h+padRef.current*2)).catch(() => {});
          void win.setPosition(new PhysicalPosition(p.x, p.y)).catch(() => {});
        });
      }
    };
    const onUp = () => {
      const d = edgeDragRef.current;
      if (!d) return;
      if (d.frame) window.cancelAnimationFrame(d.frame);
      const orig = origRef.current;
      if (orig && orig.w > 0 && d.pending) {
        scaleRef.current = clamp(d.pending.w / orig.w, MIN_SCALE, MAX_SCALE);
      }
      edgeDragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // Мышь: СКМ — закрыть; граница/угол — пропорциональный размер; снимок — перенос
  const onRootMouseDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".pin__menu, .pin__error")) return;
    if (menuRef.current) { setDemoMenu(false); e.preventDefault(); return; }
    if (e.button === 1) {
      e.preventDefault();
      closePin();
      return;
    }
    if (e.button !== 0) return;

    const dir = edgeAt(e.clientX, e.clientY);
    if (dir) {
      e.preventDefault();
      // Захват указателя: растягивание работает и за пределами окна.
      try {
        rootRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* захват не удался — тянем в пределах окна */
      }
      if (demoRef.current) {
        console.log(`[demo] snipcast_pin_resize_start ${dir}`);
        edgeDragRef.current = {
          dir,
          startScreen: { x: e.screenX, y: e.screenY },
          origPos: { x: 0, y: 0 },
          origSize: { w: window.innerWidth, h: window.innerHeight },
          frame: 0,
          pending: null,
        };
        return;
      }
      const win = getCurrentWindow();
      void Promise.all([win.outerPosition(), win.outerSize()])
        .then(([pos, size]) => {
          edgeDragRef.current = {
            dir,
            startScreen: { x: e.screenX, y: e.screenY },
            origPos: { x: pos.x, y: pos.y },
            origSize: { w: size.width-padRef.current*2, h: size.height-padRef.current*2 },
            frame: 0,
            pending: null,
          };
        })
        .catch((err) => console.error("[Snipcast] resize pin:", err));
      return;
    }

    // Двойной клик по снимку — закрыть (см. комментарий у lastPressRef).
    const now = performance.now();
    const last = lastPressRef.current;
    lastPressRef.current = { t: now, x: e.screenX, y: e.screenY };
    if (
      last &&
      now - last.t <= DOUBLE_CLICK_MS &&
      Math.abs(e.screenX - last.x) <= CLICK_SLOP_PX &&
      Math.abs(e.screenY - last.y) <= CLICK_SLOP_PX
    ) {
      lastPressRef.current = null;
      e.preventDefault();
      closePin();
      return;
    }

    if (demoRef.current) {
      console.log("[demo] snipcast_pin_drag (startDragging)");
      return;
    }
    void getCurrentWindow()
      .startDragging()
      .catch((err) => console.error("[Snipcast] drag pin:", err));
  };

  // Курсоры у границ и углов
  const onRootMouseMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const dir = edgeAt(e.clientX, e.clientY);
    setEdge((prev) => (prev === dir ? prev : dir));
  };

  const demoMenuAction = (action: PinMenuAction) => {
    setDemoMenu(false);
    if (action === "annotate") void beginAnnotation();
    else if (action === "copy") console.log("[demo] snipcast_pin_copy");
    else closePin();
  };

  if (annotationSource && origRef.current) return <CaptureOverlay pinEditor={{
    url:annotationSource,width:origRef.current.w,height:origRef.current.h,
    sessionId:editGeometry?.sessionId,revision:editGeometry?.revision,
    imageRect:editGeometry?.imageRect,panelBounds:editGeometry?.panelBounds,
    onLayout:g=>{if(editingRef.current&&g.sessionId===originalGeometryRef.current?.sessionId)
      setEditGeometry(prev=>prev?.revision===g.revision?prev:g);},
    onApply:png => finishAnnotation(png), onCancel:() => finishAnnotation(),
  }} />;

  return (
    <div
      ref={rootRef}
      className={`pin${selected?" pin--selected":""}${edge ? ` pin--edge-${edge}` : ""}`}
      style={{padding:pad,boxSizing:"border-box"}}
      onPointerDown={onRootMouseDown}
      onPointerMove={onRootMouseMove}
      onMouseLeave={() => setEdge(null)}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest(".pin__menu")) closePin(); }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (demo) { setDemoMenu(true); return; }
        // Меню — отдельное окно поверх всего: не обрезается краями закрепа.
        const cx = e.clientX;
        const cy = e.clientY;
        const dpr = window.devicePixelRatio || 1;
        const label = getCurrentWindow().label;
        void getCurrentWindow()
          .outerPosition()
          .then((pos) => {
            void invoke("snipcast_pin_menu", {
              x: Math.round(pos.x + cx * dpr),
              y: Math.round(pos.y + cy * dpr),
              scale: dpr,
              label,
            }).catch((err) => console.error("[Snipcast] pin menu:", err));
          })
          .catch((err) => console.error("[Snipcast] pin menu pos:", err));
      }}
      title="ЛКМ — переместить · двойной клик — закрыть · колесо — масштаб · границы/углы — пропорционально · СКМ — закрыть · ПКМ — меню"
    >
      {url ? (
        <img className="pin__shot" src={url} alt="" draggable={false} />
      ) : demo ? (
        <div className="pin__demo">Закреп (демо)</div>
      ) : null}

      {demoMenu ? <div className="pin__menu"><PinMenuWindow onAction={demoMenuAction} onDismiss={() => setDemoMenu(false)} /></div> : null}
      {error ? <div className="pin__error" role="alert">{error}</div> : null}

    </div>
  );
}
