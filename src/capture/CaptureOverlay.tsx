import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
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
import { useTextTool } from "./useTextTool";
import { TextEditor, TextFrame } from "./TextEditor";
import { waitForCapturePaint } from "./capturePresentation";
import "../capture.css";

type PresetInfo = {
  title: string;
  dir: string;
  fileTemplate: string;
  action: "save" | "ocr" | "pin";
};

type CaptureInfo = {
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
  | { mode: "new"; start: Pt }
  | { mode: "move"; start: Pt; orig: Rect }
  | { mode: "resize"; handle: HandleId; orig: Rect }
  | { mode: "draw"; start: Pt }
  | { mode: "shapeMove"; id: number; grab: Pt; orig: Shape }
  | { mode: "shapePoint"; id: number; point: 1 | 2; orig: Shape };


const SWATCHES = [
  "#ff4d4d", // красный — по умолчанию
  "#5164f2",
  "#ff7d72",
  "#f1bf66",
  "#f4f4f8",
  "#2fb344",
  "#22b8cf",
  "#e64980",
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

export function CaptureOverlay() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tbRef = useRef<HTMLDivElement | null>(null);

  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [k, setK] = useState(1);
  const [sel, setSel] = useState<Rect | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const scene = useAnnotationScene();
  const { shapes, setShapes } = scene;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tool, setTool] = useState<ShapeKind | null>(null);
  const [drawColor, setDrawColor] = useState(SWATCHES[0]!);
  /** Форма инструмента «Фигура»: прямоугольник/квадрат/круг/овал. */
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [drawThickness, setDrawThickness] = useState(4);
  const [textSize, setTextSize] = useState(22);
  const [hoverText, setHoverText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [hoverQuick, setHoverQuick] = useState<number | null>(null);
  const [tbSize, setTbSize] = useState<{ w: number; h: number } | null>(null);

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
  /** Метка окна, чей кадр загружен, но ещё не отрисован: ждём onLoad <img>. */
  const readySignalRef = useRef<string | null>(null);
  const presentationSeqRef = useRef(0);
  const presentableImageRef = useRef<string | null>(null);
  const shownListenerRef = useRef<Promise<unknown> | null>(null);
  const [presented, setPresented] = useState(isDemoMode);
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const textTool = useTextTool({ scene, select: setSelectedId, leaveTool: () => setTool(null),
    nextId: () => idSeqRef.current++, color: drawColor, fontSize: textSize });
  const textToolRef = useRef(textTool);
  textToolRef.current = textTool;
  const edit = textTool.edit;

  const demo = isDemoMode();
  /** Номер сессии захвата: окно живое, при каждом новом показе +1 → перезагрузка. */
  const [sessionSeq, setSessionSeq] = useState(0);

  // The native window appears transparent. Start its fade only AFTER show(),
  // never while a prewarmed WebView is still hidden.
  useEffect(() => {
    if (demo) return;
    let dead = false;
    const un = listen<string>("snipcast://capture-shown", (event) => {
      if (!dead && event.payload === presentableImageRef.current && imgRef.current?.complete) {
        setPresented(true);
      }
    });
    shownListenerRef.current = un;
    return () => { dead = true; void un.then((f) => f()); };
  }, [demo]);

  // Загрузка: инфо о захвате + PNG-байты + конфиг
  useEffect(() => {
    let dead = false;
    let objectUrl: string | null = null;

    if (demo) {
      setInfo({ label: "capture-0", imageName: "", x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1 });
      setK(window.devicePixelRatio || 1);
      setCfg(DEMO_CFG);
      return;
    }

    (async () => {
      try {
        const i = await invoke<CaptureInfo>("snipcast_capture_info");
        const buf = await invoke<ArrayBuffer>("snipcast_capture_image_data", { name: i.imageName });
        objectUrl = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        if (dead) return;
        setInfo(i);
        setK(i.scale || window.devicePixelRatio || 1);
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
  }, [sessionSeq]);

  // Окно оверлея переиспользуется между захватами (создаётся один раз):
  // новый захват бэкенд объявляет событием, и мы перезагружаем сессию.
  // Старое выделение/фигуры сбрасываем СРАЗУ в обработчике — до любого
  // показа окна, чтобы не мелькала рамка прошлой сессии.
  useEffect(() => {
    if (demo) return;
    const un = listen("snipcast://capture-session", () => {
      presentationSeqRef.current += 1;
      presentableImageRef.current = null;
      readySignalRef.current = null;
      setPresented(false);
      setSel(null);
      setDraft(null);
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
  }, [demo]);

  // Размер окна (CSS px) — выделение живёт в этих координатах
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const showToast = (kind: "ok" | "error", text: string) => {
    setToast({ kind, text });
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  };

  const closeCapture = useCallback(() => {
    if (demo) {
      console.log("[demo] snipcast_close_capture");
      return;
    }
    void invoke("snipcast_close_capture").catch((e) => console.error("[Snipcast] close_capture:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  const nextShapeId = () => idSeqRef.current++;

  const flattenSelection = useCallback((): string => {
    const snapshot = textToolRef.current.commit();
    const r = selRef.current;
    if (!r) return "";
    const kw = kRef.current || 1;
    const cvs = document.createElement("canvas");
    cvs.width = Math.max(1, Math.round(r.w * kw));
    cvs.height = Math.max(1, Math.round(r.h * kw));
    const ctx = cvs.getContext("2d");
    if (!ctx) return "";
    ctx.scale(kw, kw);
    ctx.translate(-r.x, -r.y);
    const { w, h } = vpRef.current;
    const img = imgRef.current;
    if (img && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, w, h);
    } else {
      ctx.fillStyle = "#8a8a96";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    for (const s of snapshot) drawShape(ctx, s, 1);
    ctx.restore();
    return cvs.toDataURL("image/png").split(",")[1] ?? "";
  }, []);

  // ------------------------------------------------------------------
  // Действия
  // ------------------------------------------------------------------

  const runCopy = useCallback(async () => {
    if (!selRef.current || busy) return;
    setBusy(true);
    try {
      const png = flattenSelection();
      if (demo) {
        console.log("[demo] snipcast_capture_copy: png base64 length", png.length);
        showToast("ok", "Скопировано (демо)");
        return;
      }
      await invoke("snipcast_capture_copy", { png });
      await invoke("snipcast_close_capture");
    } catch (e) {
      showToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, demo, flattenSelection]);

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

  const saveWithDialog = useCallback(
    async (preset?: PresetInfo) => {
      if (!selRef.current || busy) return;
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
        const png = flattenSelection();
        await invoke("snipcast_capture_save", { png, path });
        await invoke("snipcast_close_capture");
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
        const png = flattenSelection();
        await invoke("snipcast_capture_save", { png, path });
        await invoke("snipcast_close_capture");
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
    setBusy(true);
    try {
      const png = flattenSelection();
      const kw = kRef.current || 1;
      const box = {
        png,
        x: inf.x + Math.round(r.x * kw),
        y: inf.y + Math.round(r.y * kw),
        width: Math.max(1, Math.round(r.w * kw)),
        height: Math.max(1, Math.round(r.h * kw)),
      };
      if (demo) {
        console.log("[demo] snipcast_capture_pin", box);
        return;
      }
      await invoke("snipcast_capture_pin", box);
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
      setBusy(true);
      try {
        const png = flattenSelection();
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
    if (s && handleEl) {
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
        dragRef.current = { mode: "draw", start: pt };
        setDraft({ id: nextShapeId(), kind: activeDrawKind(), color: drawColor, thickness: drawThickness, p1: pt, p2: pt });
        return;
      }
      // Инструмент не активен: первый драг снимает выбор фигуры, дальше — рамка.
      if (selectedId != null) {
        setSelectedId(null);
        return;
      }
      dragRef.current = { mode: "move", start: pt, orig: s };
      return;
    }

    // Фон при активном инструменте: тоже сразу создаём новую фигуру/текст,
    // а не тянем выделение (иначе требовался второй клик).
    if (tool) {
      setSelectedId(null);
      if (tool === "text") { textTool.beginCreate(e); return; }
      scene.begin();
      dragRef.current = { mode: "draw", start: pt };
      setDraft({ id: nextShapeId(), kind: activeDrawKind(), color: drawColor, thickness: drawThickness, p1: pt, p2: pt });
      return;
    }

    // Фон: тянем новое выделение
    dragRef.current = { mode: "new", start: pt };
    setSelectedId(null);
    setDraft(null);
    setSel({ x: pt.x, y: pt.y, w: 0, h: 0 });
  };

  // Колесо мыши при активном инструменте — толщина линии (и кегль текста).
  // Применяем и к выбранной фигуре — как у ползунка в панели опций.
  const onRootWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (edit || (e.target as HTMLElement).closest(".capture__ui")) return;
    if (tool === "text" || shapes.find((s) => s.id === selectedId)?.kind === "text") return;
    if (!tool) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : e.deltaY < 0 ? 1 : 0;
    if (!dir) return;
    const next = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, drawThickness + dir));
    applyThickness(next);
  };

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
    const onMove = (e: PointerEvent) => {
      // Подсветка пункта меню быстрых мест, пока кнопка удерживается
      if (holdRef.current?.fired) {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-quick-idx]");
        const idx = el ? Number((el as HTMLElement).dataset.quickIdx ?? "-1") : -1;
        setHoverQuick(idx >= 0 ? idx : null);
      }

      const d = dragRef.current;
      if (!d) return;
      const pt = { x: e.clientX, y: e.clientY };
      const vw = vpRef.current.w;
      const vh = vpRef.current.h;

      if (d.mode === "new") {
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
        setDraft((prev) => {
          if (!prev) return prev;
          let p2 = pt;
          // Квадрат и круг рисуются с равными сторонами (по большей оси).
          if (prev.kind === "square" || prev.kind === "circle") {
            const m = Math.max(Math.abs(pt.x - prev.p1.x), Math.abs(pt.y - prev.p1.y));
            const sx = pt.x >= prev.p1.x ? 1 : -1;
            const sy = pt.y >= prev.p1.y ? 1 : -1;
            p2 = { x: prev.p1.x + sx * m, y: prev.p1.y + sy * m };
          }
          return { ...prev, p2 };
        });
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
            return { ...s, p1, p2 };
          }),
        );
        return;
      }
      if (d.mode === "shapePoint") {
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== d.id) return s;
            return d.point === 1
              ? s.kind === "text"
                ? { ...s, p1: pt, p2: pt }
                : { ...s, p1: pt }
              : { ...s, p2: pt };
          }),
        );
      }
    };

    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      if (d.mode === "new") {
        const s = selRef.current;
        if (!s || s.w < MIN_SEL || s.h < MIN_SEL) {
          setSel(null);
          return;
        }
        // Пресет: действие выполняется сразу после рисования новой рамки
        // (перемещение/ресайз существующей не считается).
        const preset = infoRef.current?.preset;
        if (preset) void runPresetActionRef.current?.(preset);
        return;
      }
      if (d.mode === "draw") {
        const dr = draftRef.current;
        setDraft(null);
        if (dr && Math.hypot(dr.p2.x - dr.p1.x, dr.p2.y - dr.p1.y) >= 3) {
          setShapes((prev) => [...prev, dr]);
          setSelectedId(dr.id);
        }
      }
      scene.finish();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const text = textToolRef.current;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (text.cancel()) return;
        if (dragRef.current) {
          dragRef.current = null;
          scene.cancel(); setDraft(null); setSel(dragSelectionBeforeRef.current);
          return;
        }
        if (selectedIdRef.current != null) { setSelectedId(null); return; }
        if (toolRef.current) { setTool(null); return; }
        closeCapture(); return;
      }
      if (text.editRef.current) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault(); scene.undo(e.shiftKey);
        if (!scene.ref.current.some((s) => s.id === selectedIdRef.current)) setSelectedId(null);
        return;
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
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeCapture, scene.cancel, scene.change, scene.undo]);

  // ------------------------------------------------------------------
  // Отрисовка фигур на canvas-оверлее
  // ------------------------------------------------------------------

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const { w, h } = vp;
    const kw = k || 1;
    cvs.width = Math.max(1, Math.round(w * kw));
    cvs.height = Math.max(1, Math.round(h * kw));
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
    const r = selRef.current;
    const draggingNew = dragRef.current?.mode === "new";
    if (r && !draggingNew) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      for (const s of shapes) if (visible(s)) drawShape(ctx, s, 1);
      if (draft) drawShape(ctx, draft, 1);
      ctx.restore();
    } else {
      for (const s of shapes) if (visible(s)) drawShape(ctx, s, 1);
      if (draft) drawShape(ctx, draft, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, draft, k, vp, sel, edit?.shape.id]);

  // Рамка выбранной фигуры: ключевые точки
  const selectedShape = shapes.find((s) => s.id === selectedId) ?? null;

  // Измерение панели инструментов для позиционирования
  useLayoutEffect(() => {
    const el = tbRef.current;
    if (!el) return;
    setTbSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [sel != null, ocrLoading]);

  const place = (() => {
    if (!sel) return null;
    // До первого измерения — оценка, чтобы панель успела отрендериться и измериться
    const size = tbSize ?? { w: 560, h: 58 };
    const margin = 8;
    let left = sel.x + sel.w / 2 - size.w / 2;
    left = Math.max(margin, Math.min(left, vp.w - size.w - margin));
    let top = sel.y + sel.h + margin;
    if (top + size.h > vp.h - margin) top = sel.y - margin - size.h;
    if (top < margin) top = margin;
    return { left, top, right: vp.w - (left + size.w), bottom: top + size.h };
  })();

  const theme = cfg ? resolveUiTheme(normalizeUiTheme(cfg.theme)) : "dark";

  const quickLocs = cfg?.screenshotQuickLocations ?? [];
  const toolLabels: Record<ShapeKind, string> = {
    line: "Линия",
    rect: "Фигура",
    square: "Квадрат",
    ellipse: "Овал",
    circle: "Круг",
    arrow: "Стрелка",
    text: "Текст",
  };

  const isTextContext = !!edit || selectedShape?.kind === "text" || tool === "text";
  const optsTool = isTextContext ? "text" : tool;
  const activeColor = edit?.shape.color ?? selectedShape?.color ?? drawColor;
  const activeSize = edit?.shape.fontSize ?? (selectedShape?.kind === "text" ? selectedShape.fontSize : textSize);
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
    const fontSize = Math.max(8, Math.min(128, Math.round(v)));
    setTextSize(fontSize);
    if (textTool.editRef.current) textTool.update({ fontSize });
    else if (selectedShape?.kind === "text")
      scene.change((prev) => prev.map((s) => s.id === selectedShape.id ? { ...s, fontSize } : s));
  };

  const selectedBox = selectedShape ? shapeBounds(selectedShape) : null;
  const dim = sel
    ? { top: { top: 0, left: 0, width: vp.w, height: Math.max(0, sel.y) },
        bottom: { top: sel.y + sel.h, left: 0, width: vp.w, height: Math.max(0, vp.h - sel.y - sel.h) },
        left: { top: sel.y, left: 0, width: Math.max(0, sel.x), height: sel.h },
        right: { top: sel.y, left: sel.x + sel.w, width: Math.max(0, vp.w - sel.x - sel.w), height: sel.h } }
    : null;

  return (
    <div
      ref={rootRef}
      className={`capture${presented ? " capture--presented" : ""}`}
      data-capture-theme={theme}
      style={{ cursor: hoverText ? "move" : tool === "text" ? "text" : undefined }}
      onPointerDown={onRootPointerDown}
      onPointerMove={(e) => {
        textTool.onPointerMove(e);
        if (!(e.target as HTMLElement).closest(".capture__ui, .capture__text-edit-wrap")) {
          const pt = { x: e.clientX, y: e.clientY };
          const top = [...scene.ref.current].reverse().find((s) => hitTest(s, pt));
          setHoverText(top?.kind === "text");
        } else setHoverText(false);
      }}
      onPointerLeave={() => setHoverText(false)}
      onPointerUp={textTool.onPointerUp}
      onPointerCancel={() => {
        if (textTool.gestureRef.current) textTool.cancel();
        else if (dragRef.current) {
          dragRef.current = null;
          scene.cancel(); setDraft(null); setSel(dragSelectionBeforeRef.current);
        }
      }}
      onLostPointerCapture={() => { if (textTool.gestureRef.current) textTool.cancel(); }}
      onDoubleClick={onRootDoubleClick}
      onWheel={onRootWheel}
      onContextMenu={(e) => {
        e.preventDefault();
        closeCapture();
      }}
    >
      {imgUrl ? (
        <img
          ref={imgRef}
          className="capture__shot"
          src={imgUrl}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget;
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
      {dim ? (
        <>
          <div className="capture__dim capture__dim--selection" style={dim.top} />
          <div className="capture__dim capture__dim--selection" style={dim.bottom} />
          <div className="capture__dim capture__dim--selection" style={dim.left} />
          <div className="capture__dim capture__dim--selection" style={dim.right} />
          <div className="capture__selection-reveal"
            style={{ left: sel!.x, top: sel!.y, width: sel!.w, height: sel!.h }} />
        </>
      ) : (
        <div className="capture__dim capture__dim--full" />
      )}

      <canvas ref={canvasRef} className="capture__shapes" />

      {/* Рамка выделения + маркеры + чип размеров */}
      {sel ? (
        <>
          <div
            className="capture__frame"
            style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
          >
            {HANDLES.map((h) => (
              <div key={h} data-handle={h} className={`capture__handle capture__handle--${h}`} />
            ))}
          </div>
          <div
            className="capture__dimchip"
            style={{ left: sel.x, top: sel.y >= 36 ? sel.y - 32 : sel.y + 6 }}
          >
            {Math.round(sel.w * k)} × {Math.round(sel.h * k)}
          </div>
        </>
      ) : (
        <>
          <div className="capture__hint capture__hint--top">Выделите область для снимка</div>
          {info?.preset ? (
            <div className="capture__preset-chip">Пресет: {info.preset.title}</div>
          ) : null}
          <div className="capture__hint capture__hint--esc">Esc — отменить</div>
        </>
      )}

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
          <div key={`shape-kp1-${selectedShape.id}`} className="capture__kp" data-kp="1" style={{ left: selectedShape.p1.x, top: selectedShape.p1.y }} />
          <div key={`shape-kp2-${selectedShape.id}`} className="capture__kp" data-kp="2" style={{ left: selectedShape.p2.x, top: selectedShape.p2.y }} />

        </>
      ) : null}

      {selectedShape?.kind === "text" && !edit ? <TextFrame key={selectedShape.id} shape={selectedShape} tool={textTool} /> : null}
      {textTool.frame ? <div className="capture__text-frame" style={{ left: textTool.frame.x,
        top: textTool.frame.y, width: textTool.frame.w, height: textTool.frame.h }} /> : null}
      <TextEditor tool={textTool} />

      {/* Панель инструментов, опции инструмента, меню быстрых мест, тост */}
      <div className="capture__ui">
        {sel && place ? (
          <div ref={tbRef} className="capture__toolbar" style={{ left: place.left, top: place.top }}>
              {(
                [
                  { kind: "arrow" as const, label: "Стрелка", title: "Нарисовать стрелку", icon: <IconArrow /> },
                  { kind: "line" as const, label: "Линия", title: "Нарисовать линию", icon: <IconLine /> },
                  { kind: "rect" as const, label: "Фигура", title: "Нарисовать фигуру", icon: <IconRect /> },
                  { kind: "text" as const, label: "Текст", title: "Добавить текст", icon: <IconText /> },
                ] as const
              ).map((t) => (
              <button
                key={t.kind}
                type="button"
                title={t.title}
                className={`capture__btn${tool === t.kind ? " is-active" : ""}`}
                onClick={() => { textTool.commit(); setSelectedId(null); setTool((prev) => (prev === t.kind ? null : t.kind)); }}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}

            <span className="capture__toolbar-sep" aria-hidden />

            <button
              type="button"
              title="Распознать текст"
              className="capture__btn"
              disabled={busy}
              onClick={() => void runOcr({ closeOnSuccess: true })}
            >
              <IconOcr />
              <span>{ocrLoading ? "…" : "Распознать"}</span>
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
            </button>

            <span className="capture__toolbar-sep" aria-hidden />

            <button
              type="button"
              title="Сохранить как файл"
              className="capture__btn"
              disabled={busy}
              onPointerDown={onSavePointerDown}
              onClick={onSaveClick}
            >
              <IconSave />
              <span>Сохранить</span>
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
            </button>
            <button
              type="button"
              title="Копировать в буфер обмена"
              className="capture__btn"
              disabled={busy}
              onClick={() => void runCopy()}
            >
              <IconCopy />
              <span>Копировать</span>
            </button>
          </div>
        ) : null}

        {sel && place && optsTool ? (
          <div
            className="capture__opts"
            onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }}
            style={{ right: place.right, top: place.bottom + 8 }}
          >
            <div className="capture__opts-title">{toolLabels[optsTool]}</div>
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
                    className={`capture__shape-btn${shapeKind === f.kind ? " is-active" : ""}`}
                    onClick={() => setShapeKind(f.kind)}
                  >
                    {f.icon}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="capture__opts-swatches">
              {SWATCHES.map((c) => (
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
            <label className="capture__opts-row">
              <span>{isTextContext ? "Кегль" : "Размер"}</span>
              <input type="range" aria-label={isTextContext ? "Размер текста" : "Толщина линии"}
                min={isTextContext ? 8 : MIN_THICKNESS} max={isTextContext ? 128 : MAX_THICKNESS} step={1}
                value={isTextContext ? activeSize : drawThickness}
                onPointerDown={() => { if (!edit) scene.begin(); }}
                onPointerUp={() => scene.finish()}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (isTextContext) applyTextSize(v); else applyThickness(v);
                }} />
              <span className="capture__opts-value">{isTextContext ? `${activeSize} px` : drawThickness}</span>
            </label>
          </div>
        ) : null}

        {quickOpen && place ? (
          <div className="capture__quick" style={{ right: place.right, top: place.bottom + 8 }}>
            {quickLocs.length > 0 ? (
              quickLocs.map((loc, i) => (
                <button
                  key={`${loc.path}-${i}`}
                  type="button"
                  data-quick-idx={i}
                  className={`capture__quick-item${hoverQuick === i ? " is-hover" : ""}`}
                  tabIndex={-1}
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
          <div className={`capture__toast capture__toast--${toast.kind}`} role="status">
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
