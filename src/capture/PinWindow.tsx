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
import "../capture.css";

type PinInfo = {
  label: string;
  imageName: string;
  width: number;
  height: number;
};

/** Граница/угол, за который тянут окно. */
type EdgeDir = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const EDGE_PX = 10; // полоса у краёв окна для растягивания
const MIN_SCALE = 0.15;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.1;

// Демо-режим: кадра из бэкенда нет, окно условное
const DEMO_SIZE = { w: 640, h: 400 };

const CORNERS: EdgeDir[] = ["nw", "ne", "se", "sw"];

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** Граница по позиции курсора в координатах окна (CSS px). */
function edgeAt(x: number, y: number): EdgeDir | null {
  const w = window.innerWidth;
  const h = window.innerHeight;
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
 * Закрытие: средняя кнопка мыши, ПКМ → меню, Esc.
 */
export function PinWindow() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const demo = isDemoMode();

  const [url, setUrl] = useState<string | null>(null);
  const [edge, setEdge] = useState<EdgeDir | null>(null);

  // Исходный размер кадра в физических px и текущий зафиксированный масштаб
  const origRef = useRef<{ w: number; h: number } | null>(demo ? DEMO_SIZE : null);
  const scaleRef = useRef(1);
  /** Масштаб, ожидающий применения в ближайшем кадре. */
  const pendingScaleRef = useRef<number | null>(null);
  const wheelFrameRef = useRef(0);
  const edgeDragRef = useRef<EdgeDrag | null>(null);
  const demoRef = useRef(demo);
  demoRef.current = demo;

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
      .setSize(new PhysicalSize(Math.max(16, Math.round(w)), Math.max(16, Math.round(h))))
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

  // Клавиатура: стрелки двигают окно (Shift — ×10), Esc закрывает (сначала меню)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
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
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelFrameRef.current) window.cancelAnimationFrame(wheelFrameRef.current);
    };
  }, [zoomBy]);

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
          void win.setSize(new PhysicalSize(p.w, p.h)).catch(() => {});
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
            origSize: { w: size.width, h: size.height },
            frame: 0,
            pending: null,
          };
        })
        .catch((err) => console.error("[Snipcast] resize pin:", err));
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

  return (
    <div
      ref={rootRef}
      className={`pin${edge ? ` pin--edge-${edge}` : ""}`}
      onPointerDown={onRootMouseDown}
      onPointerMove={onRootMouseMove}
      onMouseLeave={() => setEdge(null)}
      onDoubleClick={() => closePin()}
      onContextMenu={(e) => {
        e.preventDefault();
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
      title="ЛКМ — переместить · колесо — масштаб · границы/углы — пропорционально · СКМ — закрыть · ПКМ — меню"
    >
      {url ? (
        <img className="pin__shot" src={url} alt="" draggable={false} />
      ) : demo ? (
        <div className="pin__demo">Закреп (демо)</div>
      ) : (
        <div className="pin__stub" />
      )}

    </div>
  );
}
