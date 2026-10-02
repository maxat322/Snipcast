import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { keyboardEventToTauriHotkey, tauriHotkeyToDisplay } from "./hotkeyFormat";
import type {
  AppConfig,
  QuickLocation,
  ScreenshotPreset,
  TemplateGroup,
  TemplateNode,
  TemplateStore,
  UpdateInfo,
} from "./types";
import {
  applyPaletteListDensity,
  applyUiThemeSetting,
  normalizePaletteListDensity,
  normalizeUiTheme,
} from "./uiTheme";
import { SNIPCAST_LOGO_SRC } from "./branding";
import "./theme-overrides.css";
import "./Settings.css";

const REPO_URL = "https://github.com/maxat322/Snipcast";

type UpdateState = "idle" | "checking" | "available" | "uptodate" | "installing" | "error";

/** Человеческое описание этапа обновления, приходящего из бэкенда. */
function updateStageLabel(stage: string): string {
  switch (stage) {
    case "check":
      return "Запрашиваю сведения о релизе…";
    case "download":
      return "Скачиваю…";
    case "verify":
      return "Проверяю контрольную сумму…";
    case "install":
      return "Устанавливаю…";
    case "restart":
      return "Перезапускаю…";
    default:
      return "Обновляю…";
  }
}
const GROUP_COLORS = ["#5164f2", "#e8590c", "#20c997", "#be4bdb", "#339af0", "#fa5252"];

type Section = "general" | "screenshot" | "ai" | "templates" | "variables" | "update";
type GroupModalMode = "create" | "master" | null;

type OcrModelsStatus = {
  installed: boolean;
  missing: string[];
  downloadMb?: number;
  quality?: string;
};

type OcrProgress = { stage: string; done: number; total: number; message: string };

/** PaddleOCR (модели и их загрузка) пока есть только в Windows. */
const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** Максимальное число быстрых мест сохранения. */
const MAX_QUICK_LOCATIONS = 8;

/** Максимальное число пресетов быстрого скриншота (как в меню трея). */
const MAX_SCREENSHOT_PRESETS = 8;

type ApiStatus = {
  running: boolean;
  port: number;
  token: string;
  tokenPath: string;
};

/** Последний сегмент пути (разделители учитываем оба — путь приходит из системного диалога). */
function pathBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Ключ вне фокуса показываем замаскированным: начало....конец. */
function maskAiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "....";
  return `${key.slice(0, 4)}....${key.slice(-4)}`;
}

function IconCamera({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M3 8.2C3 7.1 3.9 6.2 5 6.2h2.6l1.4-2a1 1 0 0 1 .82-.42h4.36a1 1 0 0 1 .82.42l1.4 2H19c1.1 0 2 .9 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.4" r="3.4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function IconSliders({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h13M20 12h0"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
      />
      <circle cx="15" cy="7" r="2.1" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="9" cy="17" r="2.1" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18.5" cy="12" r="2.1" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function IconLayers({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 4 3.5 8.4 12 12.8l8.5-4.4L12 4Z"
        stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"
      />
      <path d="M4.5 12.4 12 16.3l7.5-3.9" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M4.5 16.4 12 20.3l7.5-3.9" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function IconBraces({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 4.5c-2 0-2 2.5-2 4s0 3-2 3.5c2 .5 2 2 2 3.5s0 4 2 4M15 4.5c2 0 2 2.5 2 4s0 3 2 3.5c-2 .5-2 2-2 3.5s0 4-2 4"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconRefresh({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

/** Искра ИИ (раздел «ИИ»): большая четырёхлучевая звезда + маленькая рядом. */
function IconSpark({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M11 5.5l1.9 4.6 4.6 1.9-4.6 1.9-1.9 4.6-1.9-4.6L4.5 12l4.6-1.9L11 5.5z"
        stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"
      />
      <path
        d="M18.5 3.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z"
        fill="currentColor" stroke="none"
      />
    </svg>
  );
}


function cloneStore(root: TemplateStore): TemplateStore {
  return JSON.parse(JSON.stringify(root)) as TemplateStore;
}

function getNodeAtPath(items: TemplateNode[], path: number[]): TemplateNode | null {
  if (path.length === 0) return null;
  let list = items;
  for (let d = 0; d < path.length; d++) {
    const idx = path[d]!;
    const node = list[idx];
    if (!node) return null;
    if (d === path.length - 1) return node;
    if (node.type !== "folder") return null;
    list = node.items;
  }
  return null;
}

function insertAfterSelection(items: TemplateNode[], selectedPath: number[] | null, item: TemplateNode) {
  if (!selectedPath || selectedPath.length === 0) {
    items.push(item);
    return;
  }
  const insertAt = selectedPath[selectedPath.length - 1]! + 1;
  const parentPath = selectedPath.slice(0, -1);
  let list = items;
  for (const idx of parentPath) {
    const node = list[idx];
    if (!node || node.type !== "folder") {
      items.push(item);
      return;
    }
    list = node.items;
  }
  list.splice(insertAt, 0, item);
}

/** Новый шаблон внутри выбранной папки (в конец списка детей). Возвращает путь к вставленному узлу. */
function appendTemplateInsideFolder(items: TemplateNode[], folderPath: number[], template: TemplateNode): number[] {
  const folder = getNodeAtPath(items, folderPath);
  if (!folder || folder.type !== "folder") {
    insertAfterSelection(items, folderPath, template);
    if (!folderPath.length) return [items.length - 1];
    const np = [...folderPath];
    np[np.length - 1] = np[np.length - 1]! + 1;
    return np;
  }
  folder.items.push(template);
  return [...folderPath, folder.items.length - 1];
}

/**
 * Один выбранный узел: шаг вверх/вниз среди соседей или выход из папки (если уже у верхней/нижней границы).
 * Вверх: если выше папка — перенос внутрь неё (последний ребёнок).
 * Вниз: если ниже папка — перенос внутрь неё (первый ребёнок).
 */
function tryMoveSingleInTree(items: TemplateNode[], path: number[], delta: -1 | 1): number[] | null {
  if (path.length === 0) return null;
  const idx = path[path.length - 1]!;
  const parentPath = path.slice(0, -1);
  const list = getListAtParent(items, parentPath);
  if (!list || !list[idx]) return null;

  if (delta === -1) {
    if (idx > 0) {
      const prev = list[idx - 1];
      if (prev?.type === "folder") {
        const [moved] = list.splice(idx, 1);
        prev.items.push(moved);
        return [...parentPath, idx - 1, prev.items.length - 1];
      }
      if (!moveBlockUpInList(list, idx, idx)) return null;
      return [...parentPath, idx - 1];
    }
    if (parentPath.length === 0) return null;
    const folderIdx = parentPath[parentPath.length - 1]!;
    const gpPath = parentPath.slice(0, -1);
    const parentList = getListAtParent(items, gpPath);
    if (!parentList) return null;
    const folderNode = parentList[folderIdx];
    if (!folderNode || folderNode.type !== "folder") return null;
    const [moved] = folderNode.items.splice(idx, 1);
    parentList.splice(folderIdx, 0, moved);
    return [...gpPath, folderIdx];
  }

  if (idx < list.length - 1) {
    const next = list[idx + 1];
    if (next?.type === "folder") {
      const [moved] = list.splice(idx, 1);
      next.items.unshift(moved);
      return [...parentPath, idx, 0];
    }
    if (!moveBlockDownInList(list, idx, idx)) return null;
    return [...parentPath, idx + 1];
  }

  if (parentPath.length === 0) return null;
  const folderIdx = parentPath[parentPath.length - 1]!;
  const gpPath = parentPath.slice(0, -1);
  const parentList = getListAtParent(items, gpPath);
  if (!parentList) return null;
  const folderNode = parentList[folderIdx];
  if (!folderNode || folderNode.type !== "folder") return null;
  const [moved] = folderNode.items.splice(idx, 1);
  parentList.splice(folderIdx + 1, 0, moved);
  return [...gpPath, folderIdx + 1];
}

function removeSelected(items: TemplateNode[], path: number[]): boolean {
  const idx = path[path.length - 1]!;
  let list = items;
  for (let d = 0; d < path.length - 1; d++) {
    const node = list[path[d]!];
    if (!node || node.type !== "folder") return false;
    list = node.items;
  }
  if (!list[idx]) return false;
  list.splice(idx, 1);
  return true;
}

function pathKey(path: number[]): string {
  return path.join(".");
}

function pathsFromKey(key: string): number[] {
  if (!key) return [];
  return key.split(".").map((x) => Number.parseInt(x, 10));
}

/** Порядок удаления: глубже и с большим индексом раньше, чтобы индексы не сбивались. */
function pathDeleteOrder(a: number[], b: number[]): number {
  if (a.length !== b.length) return b.length - a.length;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] !== b[i]) return b[i]! - a[i]!;
  }
  return 0;
}

function removePathsFromItems(items: TemplateNode[], paths: number[][]): void {
  const sorted = [...paths].sort(pathDeleteOrder);
  for (const p of sorted) {
    removeSelected(items, p);
  }
}

function getListAtParent(items: TemplateNode[], parentPath: number[]): TemplateNode[] | null {
  if (parentPath.length === 0) return items;
  let list = items;
  for (const idx of parentPath) {
    const node = list[idx];
    if (!node || node.type !== "folder") return null;
    list = node.items;
  }
  return list;
}

function moveBlockUpInList(list: TemplateNode[], start: number, end: number): boolean {
  if (start <= 0) return false;
  const blockLen = end - start + 1;
  const block = list.splice(start, blockLen);
  list.splice(start - 1, 0, ...block);
  return true;
}

function moveBlockDownInList(list: TemplateNode[], start: number, end: number): boolean {
  if (end >= list.length - 1) return false;
  const blockLen = end - start + 1;
  const block = list.splice(start, blockLen);
  list.splice(start + 1, 0, ...block);
  return true;
}

function insertManyAfterSelection(items: TemplateNode[], selectedPath: number[] | null, newItems: TemplateNode[]) {
  if (newItems.length === 0) return;
  if (!selectedPath || selectedPath.length === 0) {
    items.push(...newItems);
    return;
  }
  const insertAt = selectedPath[selectedPath.length - 1]! + 1;
  const parentPath = selectedPath.slice(0, -1);
  let list = items;
  for (const idx of parentPath) {
    const node = list[idx];
    if (!node || node.type !== "folder") {
      items.push(...newItems);
      return;
    }
    list = node.items;
  }
  list.splice(insertAt, 0, ...newItems);
}

function isTemplateNodeJson(x: unknown): x is TemplateNode {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const t = o.type;
  if (t === "separator") return typeof o.id === "string";
  if (t === "template")
    return typeof o.id === "string" && typeof o.title === "string" && typeof o.content === "string";
  if (t === "folder") {
    if (typeof o.id !== "string" || typeof o.title !== "string" || !Array.isArray(o.items)) return false;
    return (o.items as unknown[]).every(isTemplateNodeJson);
  }
  return false;
}

function remapNodeIds(node: TemplateNode): TemplateNode {
  if (node.type === "template") return { ...node, id: crypto.randomUUID() };
  if (node.type === "separator") return { type: "separator", id: crypto.randomUUID() };
  return {
    ...node,
    id: crypto.randomUUID(),
    items: node.items.map(remapNodeIds),
  };
}

function parseClipboardNodes(text: string): TemplateNode[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(data) || !data.every(isTemplateNodeJson)) return null;
  return data;
}

function asContiguousBlock(paths: number[][]): { parentPath: number[]; start: number; end: number } | null {
  if (paths.length === 0) return null;
  const L = paths[0]!.length;
  if (L === 0) return null;
  const parentPath = paths[0]!.slice(0, -1);
  for (const p of paths) {
    if (p.length !== L) return null;
    if (!p.slice(0, -1).every((v, i) => v === parentPath[i])) return null;
  }
  const idxs = paths.map((p) => p[p.length - 1]!).sort((a, b) => a - b);
  for (let i = 1; i < idxs.length; i++) {
    if (idxs[i] !== idxs[i - 1]! + 1) return null;
  }
  return { parentPath, start: idxs[0]!, end: idxs[idxs.length - 1]! };
}

function selectionAsBlockStrict(selectedKeys: Iterable<string>): { parentPath: number[]; start: number; end: number } | null {
  const keyArr = [...selectedKeys];
  const paths = keyArr.map(pathsFromKey).filter((p) => p.length > 0);
  const block = asContiguousBlock(paths);
  if (!block) return null;
  const { parentPath, start, end } = block;
  const expected = new Set<string>();
  for (let i = start; i <= end; i++) expected.add(pathKey([...parentPath, i]));
  if (expected.size !== new Set(keyArr).size) return null;
  for (const k of keyArr) {
    if (!expected.has(k)) return null;
  }
  return block;
}

function pathsEqual(a: number[] | null, b: number[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function saveConfig(next: AppConfig, opts?: { skipPaletteHotkeyApply?: boolean }): Promise<void> {
  await invoke("snipcast_save_config", {
    incoming: next,
    skip_palette_hotkey_apply: opts?.skipPaletteHotkeyApply ?? false,
  });
}

const NAV_WIDTH_KEY = "snipcast.settings.navWidth";

export function SettingsApp() {
  const [section, setSection] = useState<Section>("general");
  /** Ширина навигации: тянется сплиттером, запоминается между запусками. */
  const [navWidth, setNavWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem(NAV_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 170 && saved <= 460 ? saved : 220;
  });
  const navDragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onSplitterPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    navDragRef.current = { startX: e.clientX, startW: navWidth };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* без захвата — тянем в пределах окна */
    }
  };
  const onSplitterPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = navDragRef.current;
    if (!d) return;
    setNavWidth(Math.min(460, Math.max(170, d.startW + (e.clientX - d.startX))));
  };
  const onSplitterPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!navDragRef.current) return;
    navDragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* уже отпущено */
    }
    window.localStorage.setItem(NAV_WIDTH_KEY, String(navWidth));
  };
  const [config, setConfig] = useState<AppConfig | null>(null);
  const configRef = useRef<AppConfig | null>(null);
  configRef.current = config;

  const [autostartOn, setAutostartOn] = useState(true);
  const [hotkeyDisplay, setHotkeyDisplay] = useState("");
  const [screenshotHotkeyDisplay, setScreenshotHotkeyDisplay] = useState("");
  const [screenshotHotkeyCapturing, setScreenshotHotkeyCapturing] = useState(false);
  const [errorToast, setErrorToast] = useState("");
  const [version, setVersion] = useState("");
  const [varRows, setVarRows] = useState<{ key: string; value: string }[]>([]);
  /** До первой успешной загрузки автосохранение переменных не должно трогать диск. */
  const varsLoadedRef = useRef(false);
  /** Последнее, что реально записано в variables.json — чтобы не переписывать то же самое. */
  const lastSavedVarsRef = useRef<string | null>(null);
  /** Что именно не загрузилось: показываем постоянным баннером, а не исчезающим тостом. */
  const [loadErrors, setLoadErrors] = useState<string[]>([]);

  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateStage, setUpdateStage] = useState("");
  const [updateError, setUpdateError] = useState("");
  /** Портативную сборку могли положить туда, куда нельзя писать без администратора. */
  const [updateWritable, setUpdateWritable] = useState(true);

  const [ocrLanguages, setOcrLanguages] = useState<string[]>([]);
  const [paddleStatus, setPaddleStatus] = useState<OcrModelsStatus | null>(null);
  const [paddleDownloading, setPaddleDownloading] = useState(false);
  const [paddleProgress, setPaddleProgress] = useState<OcrProgress | null>(null);
  const [paddleError, setPaddleError] = useState("");
  /** Черновики текстовых полей раздела «Скриншот»: на диск пишем с задержкой, а не на каждый символ. */
  const [fileTemplateDraft, setFileTemplateDraft] = useState("");
  const [jpegQualityDraft, setJpegQualityDraft] = useState(90);
  const [quickLocationsDraft, setQuickLocationsDraft] = useState<QuickLocation[]>([]);
  const [presetsDraft, setPresetsDraft] = useState<ScreenshotPreset[]>([]);
  /** Индекс пресета, чей хоткей сейчас записывается (для плейсхолдера поля). */
  const [presetHotkeyCapturing, setPresetHotkeyCapturing] = useState<number | null>(null);
  /** True, пока какое-либо поле хоткея пресета в фокусе (для снятия хоткеев после сохранения). */
  const presetCapturingRef = useRef(false);
  const [apiPortDraft, setApiPortDraft] = useState("");
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null);
  const [apiError, setApiError] = useState("");
  const [apiTokenVisible, setApiTokenVisible] = useState(false);
  const [apiTokenCopied, setApiTokenCopied] = useState(false);
  const [apiRegenHint, setApiRegenHint] = useState(false);
  /** Раздел «ИИ»: черновики ключа/модели (на диск пишем с задержкой). */
  const [aiKeyDraft, setAiKeyDraft] = useState("");
  /** В фокусе показываем реальный ключ (для редактирования), вне — маску. */
  const [aiKeyFocused, setAiKeyFocused] = useState(false);
  const [aiModelDraft, setAiModelDraft] = useState("");
  const [aiTesting, setAiTesting] = useState(false);
  /** null — проверки ещё не было; true/false — результат snipcast_ai_test. */
  const [aiTestOk, setAiTestOk] = useState<boolean | null>(null);
  const [aiTestError, setAiTestError] = useState("");

  const [store, setStore] = useState<TemplateStore | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  /** Ключи вида "0.1.2" для мультивыбора (Ctrl+клик). */
  const [selectedPathKeysArr, setSelectedPathKeysArr] = useState<string[]>([]);
  const [primaryPath, setPrimaryPath] = useState<number[] | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [editorTitle, setEditorTitle] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [groupModalMode, setGroupModalMode] = useState<GroupModalMode>(null);
  const [groupModalName, setGroupModalName] = useState("");
  const [groupModalPath, setGroupModalPath] = useState("");
  const colorInputRef = useRef<HTMLInputElement>(null);

  const showError = useCallback((e: unknown) => {
    setErrorToast(String(e));
    setTimeout(() => setErrorToast(""), 5000);
  }, []);

  const patchAppConfig = useCallback(
    async (patch: Partial<AppConfig>) => {
      if (!config) return;
      const next: AppConfig = { ...config, ...patch };
      setConfig(next);
      if ("theme" in patch) applyUiThemeSetting(normalizeUiTheme(next.theme));
      if ("paletteListDensity" in patch) {
        applyPaletteListDensity(normalizePaletteListDensity(next.paletteListDensity));
      }
      try {
        await saveConfig(next, { skipPaletteHotkeyApply: true });
        // Бэкенд присваивает id пресетам, пришедшим с пустым id. Подтягиваем
        // назначенные идентификаторы, чтобы повторные сохранения и ссылки
        // из скриптов (POST /preset) не теряли пресет при смене id.
        if ("screenshotPresets" in patch) {
          const saved = await invoke<AppConfig>("snipcast_get_config");
          setConfig((prev) =>
            prev ? { ...prev, screenshotPresets: saved.screenshotPresets } : prev,
          );
          setPresetsDraft(saved.screenshotPresets);
        }
      } catch (e) {
        showError(e);
      }
    },
    [config, showError],
  );

  const persistStore = useCallback(async (next: TemplateStore) => {
    await invoke("snipcast_save_template_store", { store: next });
    setStore(next);
  }, []);

  const loadAll = useCallback(async () => {
    // Каждый кусок грузим независимо: одна битая часть (например, файл шаблонов)
    // не должна оставлять окно настроек без конфига и молча ломать все переключатели.
    const [cRes, vRes, varsRes, tmplRes] = await Promise.allSettled([
      invoke<AppConfig>("snipcast_get_config"),
      invoke<string>("snipcast_get_version"),
      invoke<Record<string, unknown>>("snipcast_get_variables"),
      invoke<TemplateStore>("snipcast_get_template_store"),
    ]);

    const problems: string[] = [];

    if (cRes.status === "fulfilled") {
      const c = cRes.value;
      setConfig(c);
      applyUiThemeSetting(normalizeUiTheme(c.theme));
      applyPaletteListDensity(normalizePaletteListDensity(c.paletteListDensity));
      setHotkeyDisplay(tauriHotkeyToDisplay(c.paletteHotkey));
      setScreenshotHotkeyDisplay(tauriHotkeyToDisplay(c.screenshotHotkey));
      setFileTemplateDraft(c.screenshotFileTemplate);
      setJpegQualityDraft(c.screenshotJpegQuality);
      setQuickLocationsDraft(c.screenshotQuickLocations);
      setPresetsDraft(c.screenshotPresets);
      setApiPortDraft(String(c.apiPort));
      setAiKeyDraft(c.aiApiKey ?? "");
      setAiModelDraft(c.aiModel ?? "");
    } else {
      problems.push(`настройки: ${String(cRes.reason)}`);
    }

    if (vRes.status === "fulfilled") setVersion(vRes.value);

    if (varsRes.status === "fulfilled") {
      const rows = Object.entries(varsRes.value).map(([key, val]) => ({
        key,
        value: typeof val === "string" ? val : JSON.stringify(val),
      }));
      const loadedMap: Record<string, unknown> = {};
      for (const r of rows) {
        const k = r.key.trim();
        if (k) loadedMap[k] = r.value;
      }
      lastSavedVarsRef.current = JSON.stringify(loadedMap);
      setVarRows(rows.length ? rows : [{ key: "", value: "" }]);
      varsLoadedRef.current = true;
    } else {
      problems.push(`переменные: ${String(varsRes.reason)}`);
    }

    if (tmplRes.status === "fulfilled") {
      const tmpl = tmplRes.value;
      setStore(tmpl);
      setSelectedGroupId((prev) => prev ?? tmpl.groups[0]?.id ?? null);
    } else {
      problems.push(`шаблоны: ${String(tmplRes.reason)}`);
    }

    const enabled = await isEnabled().catch(() => false);
    setAutostartOn(enabled);

    setLoadErrors(problems);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("snipcast://update-stage", (e) => setUpdateStage(e.payload)).then((f) => {
      unlisten = f;
    });
    void invoke<boolean>("snipcast_update_writable")
      .then(setUpdateWritable)
      .catch(() => setUpdateWritable(true));
    return () => unlisten?.();
  }, []);

  // Прогресс загрузки моделей PaddleOCR: загрузка идёт в фоне, финал приходит здесь же
  // (stage "done" / "error"), поэтому статус моделей перечитываем по событию.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<OcrProgress>("snipcast://ocr-progress", (e) => {
      const p = e.payload;
      setPaddleProgress(p);
      if (p.stage === "done") {
        setPaddleDownloading(false);
        setPaddleError("");
        void invoke<OcrModelsStatus>("snipcast_ocr_models_status")
          .then(setPaddleStatus)
          .catch(() => {});
      } else if (p.stage === "error") {
        setPaddleDownloading(false);
        setPaddleError(p.message);
      }
    }).then((f) => {
      unlisten = f;
    });
    return () => unlisten?.();
  }, []);

  // Языки системного OCR достаточно запросить один раз за жизнь окна.
  useEffect(() => {
    let cancelled = false;
    void invoke<string[]>("snipcast_ocr_languages")
      .then((langs) => {
        if (!cancelled) setOcrLanguages(langs);
      })
      .catch(() => {
        /* Селект останется только с «Как в системе» — не критично. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const paddleBlockVisible =
    section === "screenshot" && config?.screenshotOcrEngine === "paddle" && !IS_MAC;

  useEffect(() => {
    if (!paddleBlockVisible) return;
    let cancelled = false;
    void invoke<OcrModelsStatus>("snipcast_ocr_models_status")
      .then((st) => {
        if (!cancelled) setPaddleStatus(st);
      })
      .catch((e) => {
        if (!cancelled) setPaddleError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [paddleBlockVisible]);

  const checkUpdate = useCallback(async () => {
    setUpdateError("");
    setUpdateState("checking");
    try {
      const info = await invoke<UpdateInfo>("snipcast_check_update");
      setUpdateInfo(info);
      setUpdateState(info.available ? "available" : "uptodate");
    } catch (e) {
      setUpdateError(String(e));
      setUpdateState("error");
    }
  }, []);

  const installUpdate = useCallback(async () => {
    setUpdateError("");
    setUpdateStage("check");
    setUpdateState("installing");
    try {
      await invoke("snipcast_install_update");
      // Обычно сюда не возвращаемся: приложение перезапускается само.
    } catch (e) {
      setUpdateError(String(e));
      setUpdateState("error");
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      if (config?.theme === "system") {
        applyUiThemeSetting("system");
      }
    };
    mq.addEventListener("change", onScheme);
    return () => mq.removeEventListener("change", onScheme);
  }, [config?.theme]);

  useEffect(() => {
    // Без этой проверки эффект срабатывал на монтировании окна с пустым varRows
    // и, если загрузка не укладывалась в 500 мс, затирал variables.json пустым `{}`.
    if (!varsLoadedRef.current) return;

    const map: Record<string, unknown> = {};
    for (const r of varRows) {
      const k = r.key.trim();
      if (!k) continue;
      map[k] = r.value;
    }
    const serialized = JSON.stringify(map);
    // Ничего не изменилось по сравнению с тем, что уже на диске — не пишем.
    if (serialized === lastSavedVarsRef.current) return;

    const t = window.setTimeout(() => {
      void invoke("snipcast_save_variables", { map })
        .then(() => {
          lastSavedVarsRef.current = serialized;
        })
        .catch(showError);
    }, 500);
    return () => clearTimeout(t);
  }, [varRows, showError]);

  // Раздел «Скриншот»: текстовые поля и качество сохраняем с задержкой,
  // структурные изменения (выбор/удаление папок) пишутся сразу из хендлеров.
  useEffect(() => {
    if (!config || fileTemplateDraft === config.screenshotFileTemplate) return;
    const t = window.setTimeout(() => {
      void patchAppConfig({ screenshotFileTemplate: fileTemplateDraft });
    }, 500);
    return () => clearTimeout(t);
  }, [fileTemplateDraft, config, patchAppConfig]);

  useEffect(() => {
    if (!config || jpegQualityDraft === config.screenshotJpegQuality) return;
    const t = window.setTimeout(() => {
      void patchAppConfig({ screenshotJpegQuality: jpegQualityDraft });
    }, 300);
    return () => clearTimeout(t);
  }, [jpegQualityDraft, config, patchAppConfig]);

  useEffect(() => {
    if (!config) return;
    if (JSON.stringify(quickLocationsDraft) === JSON.stringify(config.screenshotQuickLocations)) return;
    const t = window.setTimeout(() => {
      void patchAppConfig({ screenshotQuickLocations: quickLocationsDraft });
    }, 500);
    return () => clearTimeout(t);
  }, [quickLocationsDraft, config, patchAppConfig]);

  // Пресеты: черновик, сохранение с задержкой (хоткеи бэкенд валидирует целиком).
  useEffect(() => {
    if (!config) return;
    if (JSON.stringify(presetsDraft) === JSON.stringify(config.screenshotPresets)) return;
    const t = window.setTimeout(() => {
      void patchAppConfig({ screenshotPresets: presetsDraft });
    }, 500);
    return () => clearTimeout(t);
  }, [presetsDraft, config, patchAppConfig]);

  // Раздел «ИИ»: ключ и модель пишем с задержкой, как шаблон имени файла.
  useEffect(() => {
    if (!config || aiKeyDraft === config.aiApiKey) return;
    const t = window.setTimeout(() => {
      void patchAppConfig({ aiApiKey: aiKeyDraft });
    }, 500);
    return () => clearTimeout(t);
  }, [aiKeyDraft, config, patchAppConfig]);

  useEffect(() => {
    if (!config || aiModelDraft === config.aiModel) return;
    const t = window.setTimeout(() => {
      void patchAppConfig({ aiModel: aiModelDraft });
    }, 500);
    return () => clearTimeout(t);
  }, [aiModelDraft, config, patchAppConfig]);

  /** Проверка ключа/модели на стороне бэкенда; ошибка приходит через reject. */
  const runAiTest = useCallback(async () => {
    setAiTesting(true);
    setAiTestOk(null);
    setAiTestError("");
    try {
      await invoke<string>("snipcast_ai_test");
      setAiTestOk(true);
    } catch (e) {
      setAiTestOk(false);
      setAiTestError(String(e));
    } finally {
      setAiTesting(false);
    }
  }, []);

  const refreshApiStatus = useCallback(async () => {
    try {
      const st = await invoke<ApiStatus>("snipcast_api_status");
      setApiStatus(st);
      setApiError("");
    } catch (e) {
      // Без Tauri (обычный браузер) или при сбое сервера — просто показываем ошибку.
      console.error("[Snipcast] не удалось получить статус внешнего API:", e);
      setApiError(String(e));
    }
  }, []);

  // Статус API нужен, когда открыт раздел «Скриншот».
  useEffect(() => {
    if (section !== "screenshot") return;
    void refreshApiStatus();
  }, [section, refreshApiStatus]);

  // Порт API: клиентская валидация 1024..65535, сохранение с задержкой;
  // после сохранения статус перечитываем (сервер перезапускается сам).
  const apiPortParsed = Number.parseInt(apiPortDraft, 10);
  const apiPortInvalid =
    apiPortDraft.trim() !== "" &&
    (!Number.isInteger(apiPortParsed) || apiPortParsed < 1024 || apiPortParsed > 65535);

  useEffect(() => {
    if (!config || apiPortDraft.trim() === "" || apiPortInvalid) return;
    if (apiPortParsed === config.apiPort) return;
    const t = window.setTimeout(() => {
      void patchAppConfig({ apiPort: apiPortParsed }).then(refreshApiStatus);
    }, 500);
    return () => clearTimeout(t);
  }, [apiPortDraft, apiPortParsed, apiPortInvalid, config, patchAppConfig, refreshApiStatus]);

  const selectedGroup = useMemo<TemplateGroup | null>(() => {
    if (!store || !selectedGroupId) return null;
    return store.groups.find((g) => g.id === selectedGroupId) ?? null;
  }, [store, selectedGroupId]);

  const selectedPathKeySet = useMemo(() => new Set(selectedPathKeysArr), [selectedPathKeysArr]);

  useEffect(() => {
    if (selectedPathKeysArr.length === 0) {
      setPrimaryPath(null);
      return;
    }
    setPrimaryPath((pp) => {
      if (pp) {
        const k = pathKey(pp);
        if (selectedPathKeysArr.includes(k)) return pp;
      }
      return pathsFromKey(selectedPathKeysArr[0]!);
    });
  }, [selectedPathKeysArr]);

  const selectedNode = useMemo(() => {
    if (!selectedGroup || !primaryPath) return null;
    return getNodeAtPath(selectedGroup.items, primaryPath);
  }, [selectedGroup, primaryPath]);

  useEffect(() => {
    if (!selectedGroup || !primaryPath) {
      setEditorTitle("");
      setEditorContent("");
      return;
    }
    const node = getNodeAtPath(selectedGroup.items, primaryPath);
    if (!node) {
      setEditorTitle("");
      setEditorContent("");
      return;
    }
    if (node.type === "template") {
      setEditorTitle(node.title);
      setEditorContent(node.content);
      return;
    }
    if (node.type === "folder") {
      setEditorTitle(node.title);
      setEditorContent("");
      return;
    }
    setEditorTitle("");
    setEditorContent("");
  }, [selectedGroup, primaryPath]);

  useEffect(() => {
    if (!store || !selectedGroup || !primaryPath || selectedGroup.isMaster) return;
    const node = getNodeAtPath(selectedGroup.items, primaryPath);
    if (!node || (node.type !== "template" && node.type !== "folder")) return;

    // Раньше `store` в зависимостях приводил к самоподдерживающемуся циклу:
    // persistStore менял store -> эффект перезапускался -> ещё одна запись на диск
    // без единого нажатия клавиши. Теперь пишем только при реальном отличии.
    const titleSame = node.title === editorTitle;
    const contentSame = node.type !== "template" || node.content === editorContent;
    if (titleSame && contentSame) return;

    const t = window.setTimeout(() => {
      const next = cloneStore(store);
      const g = next.groups.find((x) => x.id === selectedGroup.id);
      if (!g) return;
      const live = getNodeAtPath(g.items, primaryPath);
      if (!live || live.type !== node.type || live.id !== node.id) return;
      if (live.type === "template") {
        live.title = editorTitle;
        live.content = editorContent;
      } else {
        live.title = editorTitle;
      }
      void persistStore(next).catch(showError);
    }, 350);
    return () => clearTimeout(t);
  }, [
    editorTitle,
    editorContent,
    primaryPath,
    selectedGroup,
    selectedGroup?.isMaster,
    store,
    persistStore,
    showError,
  ]);

  const onAutostartToggle = async (on: boolean) => {
    setAutostartOn(on);
    try {
      if (on) await enable();
      else await disable();
    } catch {
      // ignore plugin error
    }
    const base = configRef.current;
    if (!base) return;
    const next = { ...base, autostart: on };
    try {
      await saveConfig(next);
      setConfig(next);
    } catch (e) {
      showError(e);
    }
  };

  const onHotkeyFocus = () => {
    void invoke("snipcast_palette_hotkey_pause").catch(() => {});
  };

  const onHotkeyBlur = () => {
    void invoke("snipcast_palette_hotkey_resume").catch(showError);
  };

  const onHotkeyKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.code === "Escape") {
      e.currentTarget.blur();
      return;
    }
    const tauri = keyboardEventToTauriHotkey(e.nativeEvent);
    if (!tauri) return;
    const base = configRef.current;
    if (!base) return;
    const next = { ...base, paletteHotkey: tauri };
    setHotkeyDisplay(tauriHotkeyToDisplay(tauri));
    try {
      await saveConfig(next, { skipPaletteHotkeyApply: true });
      setConfig(next);
    } catch (err) {
      showError(err);
    }
  };

  const onScreenshotHotkeyFocus = () => {
    setScreenshotHotkeyCapturing(true);
    void invoke("snipcast_screenshot_hotkey_pause").catch(() => {});
  };

  const onScreenshotHotkeyBlur = () => {
    setScreenshotHotkeyCapturing(false);
    void invoke("snipcast_screenshot_hotkey_resume").catch(showError);
  };

  const onScreenshotHotkeyKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.code === "Escape") {
      e.currentTarget.blur();
      return;
    }
    const tauri = keyboardEventToTauriHotkey(e.nativeEvent);
    if (!tauri) return;
    const base = configRef.current;
    if (!base) return;
    const next = { ...base, screenshotHotkey: tauri };
    setScreenshotHotkeyDisplay(tauriHotkeyToDisplay(tauri));
    try {
      // Как у палитры: пока поле в фокусе, комбинация снята (pause) и применится resume по blur.
      await saveConfig(next, { skipPaletteHotkeyApply: true });
      setConfig(next);
    } catch (err) {
      showError(err);
    }
  };

  const onClearPaletteHotkey = async () => {
    const base = configRef.current;
    if (!base || !base.paletteHotkey.trim()) return;
    const next = { ...base, paletteHotkey: "" };
    setHotkeyDisplay("");
    try {
      // Без skip: бэкенд сразу снимает прежнюю комбинацию.
      await saveConfig(next);
    } catch (e) {
      showError(e);
    }
  };

  const onClearScreenshotHotkey = async () => {
    const base = configRef.current;
    if (!base || !base.screenshotHotkey.trim()) return;
    const next = { ...base, screenshotHotkey: "" };
    setScreenshotHotkeyDisplay("");
    try {
      // Без skip: бэкенд должен снять прежнюю комбинацию сразу
      // (resume с пустым хоткеем старую регистрацию не убирает).
      await saveConfig(next);
      setConfig(next);
    } catch (e) {
      showError(e);
    }
  };

  const pickScreenshotSaveDir = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: "Выберите папку для скриншотов",
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path !== "string") return;
      await patchAppConfig({ screenshotSaveDir: path });
    } catch (e) {
      showError(e);
    }
  };

  const addQuickLocation = async () => {
    if (quickLocationsDraft.length >= MAX_QUICK_LOCATIONS) return;
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: "Выберите папку для быстрого сохранения",
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path !== "string") return;
      const next = [...quickLocationsDraft, { name: pathBasename(path), path }];
      setQuickLocationsDraft(next);
      await patchAppConfig({ screenshotQuickLocations: next });
    } catch (e) {
      showError(e);
    }
  };

  const removeQuickLocation = async (idx: number) => {
    const next = quickLocationsDraft.filter((_, j) => j !== idx);
    setQuickLocationsDraft(next);
    await patchAppConfig({ screenshotQuickLocations: next });
  };

  const renameQuickLocation = (idx: number, name: string) => {
    setQuickLocationsDraft((prev) => prev.map((q, j) => (j === idx ? { ...q, name } : q)));
  };

  // ------------------------------------------------------------------
  // Пресеты быстрого скриншота
  // ------------------------------------------------------------------

  const updatePreset = (idx: number, patch: Partial<ScreenshotPreset>) => {
    setPresetsDraft((prev) => prev.map((p, j) => (j === idx ? { ...p, ...patch } : p)));
  };

  const addPreset = () => {
    if (presetsDraft.length >= MAX_SCREENSHOT_PRESETS) return;
    // id="" — бэкенд присвоит постоянный id при сохранении конфига.
    setPresetsDraft((prev) => [
      ...prev,
      { id: "", title: "Новый пресет", hotkey: "", dir: "", fileTemplate: "", action: "save", select: true },
    ]);
  };

  const removePreset = (idx: number) => {
    setPresetsDraft((prev) => prev.filter((_, j) => j !== idx));
    if (presetHotkeyCapturing === idx) setPresetHotkeyCapturing(null);
  };

  const pickPresetDir = async (idx: number) => {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: "Папка пресета быстрого скриншота",
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path !== "string") return;
      updatePreset(idx, { dir: path });
    } catch (e) {
      showError(e);
    }
  };

  // Запись хоткея пресета: пока поле в фокусе, все хоткеи пресетов сняты
  // (snipcast_preset_hotkeys_pause), применяются обратно по blur (resume).

  const onPresetHotkeyFocus = (idx: number) => {
    setPresetHotkeyCapturing(idx);
    presetCapturingRef.current = true;
    void invoke("snipcast_preset_hotkeys_pause").catch(() => {});
  };

  const onPresetHotkeyBlur = () => {
    setPresetHotkeyCapturing(null);
    presetCapturingRef.current = false;
    void invoke("snipcast_preset_hotkeys_resume").catch(showError);
  };

  const savePresetsNow = async (nextPresets: ScreenshotPreset[]) => {
    const base = configRef.current;
    if (!base) return;
    const next = { ...base, screenshotPresets: nextPresets };
    try {
      await saveConfig(next, { skipPaletteHotkeyApply: true });
      setConfig(next);
    } catch (e) {
      // Дубликаты комбинаций и прочие ошибки валидации бэкенда — сюда.
      showError(e);
    }
  };

  const onPresetHotkeyKeyDown = async (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.code === "Escape") {
      e.currentTarget.blur();
      return;
    }
    const tauri = keyboardEventToTauriHotkey(e.nativeEvent);
    if (!tauri) return;
    const nextPresets = presetsDraft.map((p, j) => (j === idx ? { ...p, hotkey: tauri } : p));
    setPresetsDraft(nextPresets);
    await savePresetsNow(nextPresets);
    // Сохранение перерегистрировало комбинации. Если поле всё ещё в фокусе —
    // снимем снова, чтобы нажатия при записи не запускали чужие пресеты.
    if (presetCapturingRef.current) {
      void invoke("snipcast_preset_hotkeys_pause").catch(() => {});
    }
  };

  const clearPresetHotkey = async (idx: number) => {
    const nextPresets = presetsDraft.map((p, j) => (j === idx ? { ...p, hotkey: "" } : p));
    setPresetsDraft(nextPresets);
    await savePresetsNow(nextPresets);
  };

  // ------------------------------------------------------------------
  // Внешний API (для скриптов)
  // ------------------------------------------------------------------

  const onApiToggle = async (on: boolean) => {
    await patchAppConfig({ apiEnabled: on });
    await refreshApiStatus();
  };

  const copyApiToken = async () => {
    const token = apiStatus?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setApiTokenCopied(true);
      window.setTimeout(() => setApiTokenCopied(false), 1500);
    } catch (e) {
      showError(e);
    }
  };

  const regenerateApiToken = async () => {
    try {
      const token = await invoke<string>("snipcast_api_token_regenerate");
      setApiStatus((prev) => (prev ? { ...prev, token } : prev));
      setApiRegenHint(true);
      window.setTimeout(() => setApiRegenHint(false), 4000);
    } catch (e) {
      showError(e);
    }
  };

  const onDownloadOcrModels = async () => {
    setPaddleError("");
    setPaddleDownloading(true);
    setPaddleProgress(null);
    try {
      // Только запуск: прогресс и финал (done/error) приходят событием snipcast://ocr-progress.
      await invoke("snipcast_ocr_download_models");
    } catch (e) {
      setPaddleDownloading(false);
      setPaddleError(String(e));
    }
  };

  const setSelectedGroup = (groupId: string) => {
    setSelectedGroupId(groupId);
    setSelectedPathKeysArr([]);
    setPrimaryPath(null);
    setEditorTitle("");
    setEditorContent("");
  };

  const openGroupModal = (mode: GroupModalMode) => {
    setGroupModalMode(mode);
    setGroupModalName("");
    setGroupModalPath("");
  };

  const closeGroupModal = () => {
    setGroupModalMode(null);
    setGroupModalName("");
    setGroupModalPath("");
  };

  const onConfirmGroupModal = async () => {
    if (!store || !groupModalMode) return;
    const next = cloneStore(store);
    let newGroup: TemplateGroup;

    if (groupModalMode === "master") {
      const path = groupModalPath.trim();
      if (!path) {
        showError("Выберите JSON файл шаблона мастер-группы");
        return;
      }
      try {
        newGroup = await invoke<TemplateGroup>("snipcast_import_master_group", { path });
        newGroup = {
          ...newGroup,
          isMaster: true,
          masterSourcePath: path,
        };
        if (next.groups.some((g) => g.id === newGroup.id)) {
          newGroup = { ...newGroup, id: `group-${crypto.randomUUID()}` };
        }
      } catch (e) {
        showError(e);
        return;
      }
    } else {
      const requestedName = groupModalName.trim();
      if (!requestedName) {
        showError("Введите название группы");
        return;
      }
      newGroup = {
        id: `group-${crypto.randomUUID()}`,
        title: requestedName,
        color: GROUP_COLORS[next.groups.length % GROUP_COLORS.length]!,
        isMaster: false,
        masterSourcePath: undefined,
        items: [],
      };
    }

    next.groups.push(newGroup);
    try {
      await persistStore(next);
      setSelectedGroup(newGroup.id);
      closeGroupModal();
    } catch (e) {
      showError(e);
    }
  };

  const pickMasterGroupFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Выберите JSON файл мастер группы",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === "string") {
        setGroupModalPath(path);
      }
    } catch (e) {
      showError(e);
    }
  };

  const importEditableTemplateFromFile = async () => {
    if (!store) return;
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Импорт группы из JSON",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path !== "string") return;
      const imported = await invoke<TemplateGroup>("snipcast_import_template_group", { path });
      const next = cloneStore(store);
      let newGroup: TemplateGroup = {
        ...imported,
        isMaster: false,
        masterSourcePath: undefined,
      };
      if (next.groups.some((g) => g.id === newGroup.id)) {
        newGroup = { ...newGroup, id: `group-${crypto.randomUUID()}` };
      }
      next.groups.push(newGroup);
      try {
        await persistStore(next);
        setSelectedGroup(newGroup.id);
      } catch (e) {
        showError(e);
      }
    } catch (e) {
      showError(e);
    }
  };

  const exportSelectedGroupToFile = async () => {
    if (!store || !selectedGroupId || !selectedGroup || selectedGroup.isMaster) return;
    const safeTitle = (selectedGroup.title || "group").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);
    try {
      const path = await save({
        title: "Экспорт группы в JSON",
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: `${safeTitle || "group"}.json`,
      });
      if (!path) return;
      await invoke("snipcast_export_template_group", { groupId: selectedGroupId, path });
    } catch (e) {
      showError(e);
    }
  };

  const onDeleteGroup = async () => {
    if (!store || !selectedGroupId) return;
    const next = cloneStore(store);
    const idx = next.groups.findIndex((g) => g.id === selectedGroupId);
    if (idx < 0) return;
    next.groups.splice(idx, 1);
    try {
      await persistStore(next);
      setSelectedGroup(next.groups[idx]?.id ?? next.groups[idx - 1]?.id ?? null);
    } catch (e) {
      showError(e);
    }
  };

  const updateSelectedGroup = async (patch: Partial<TemplateGroup>) => {
    if (!store || !selectedGroupId) return;
    const next = cloneStore(store);
    const g = next.groups.find((x) => x.id === selectedGroupId);
    if (!g) return;
    Object.assign(g, patch);
    try {
      await persistStore(next);
    } catch (e) {
      showError(e);
    }
  };

  const onAddNode = async (type: "template" | "folder" | "separator") => {
    if (!store || !selectedGroup || selectedGroup.isMaster) return;
    const next = cloneStore(store);
    const g = next.groups.find((x) => x.id === selectedGroup.id);
    if (!g) return;
    const node: TemplateNode =
      type === "template"
        ? { type: "template", id: crypto.randomUUID(), title: "Новый шаблон", content: "" }
        : type === "folder"
          ? { type: "folder", id: crypto.randomUUID(), title: "Новый подпункт", items: [] }
          : { type: "separator", id: crypto.randomUUID() };

    let np: number[];
    if (type === "template" && primaryPath?.length) {
      const sel = getNodeAtPath(g.items, primaryPath);
      if (sel?.type === "folder") {
        np = appendTemplateInsideFolder(g.items, primaryPath, node);
      } else {
        insertAfterSelection(g.items, primaryPath, node);
        np = [...primaryPath];
        np[np.length - 1] = np[np.length - 1]! + 1;
      }
    } else {
      insertAfterSelection(g.items, primaryPath, node);
      if (!primaryPath || primaryPath.length === 0) {
        np = [g.items.length - 1];
      } else {
        np = [...primaryPath];
        np[np.length - 1] = np[np.length - 1]! + 1;
      }
    }

    try {
      await persistStore(next);
      setSelectedPathKeysArr([pathKey(np)]);
      setPrimaryPath(np);
    } catch (e) {
      showError(e);
    }
  };

  const onMove = async (delta: -1 | 1) => {
    if (!store || !selectedGroup || selectedGroup.isMaster || selectedPathKeysArr.length === 0 || !primaryPath) return;
    const next = cloneStore(store);
    const g = next.groups.find((x) => x.id === selectedGroup.id);
    if (!g) return;

    if (selectedPathKeysArr.length === 1) {
      const newPath = tryMoveSingleInTree(g.items, primaryPath, delta);
      if (!newPath) return;
      try {
        await persistStore(next);
        setSelectedPathKeysArr([pathKey(newPath)]);
        setPrimaryPath(newPath);
      } catch (e) {
        showError(e);
      }
      return;
    }

    const block = selectionAsBlockStrict(selectedPathKeySet);
    if (!block) return;
    const list = getListAtParent(g.items, block.parentPath);
    if (!list) return;
    const ok = delta === -1 ? moveBlockUpInList(list, block.start, block.end) : moveBlockDownInList(list, block.start, block.end);
    if (!ok) return;
    try {
      await persistStore(next);
      const newStart = delta === -1 ? block.start - 1 : block.start + 1;
      const len = block.end - block.start + 1;
      const newKeys = Array.from({ length: len }, (_, i) => pathKey([...block.parentPath, newStart + i]));
      setSelectedPathKeysArr(newKeys);
      setPrimaryPath([...block.parentPath, newStart]);
    } catch (e) {
      showError(e);
    }
  };

  const onDeleteNode = useCallback(async () => {
    if (!store || !selectedGroup || selectedPathKeysArr.length === 0 || selectedGroup.isMaster) return;
    const next = cloneStore(store);
    const g = next.groups.find((x) => x.id === selectedGroup.id);
    if (!g) return;
    const paths = selectedPathKeysArr.map(pathsFromKey);
    removePathsFromItems(g.items, paths);
    try {
      await persistStore(next);
      setSelectedPathKeysArr([]);
      setPrimaryPath(null);
      setEditorTitle("");
      setEditorContent("");
    } catch (e) {
      showError(e);
    }
  }, [store, selectedGroup, selectedPathKeysArr, persistStore, showError]);

  const onCopyTemplateNodes = useCallback(async () => {
    if (!selectedGroup || selectedPathKeysArr.length === 0) return;
    const paths = [...selectedPathKeysArr].map(pathsFromKey);
    const nodes: TemplateNode[] = [];
    for (const p of paths) {
      const n = getNodeAtPath(selectedGroup.items, p);
      if (n) nodes.push(JSON.parse(JSON.stringify(n)) as TemplateNode);
    }
    if (nodes.length === 0) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(nodes));
    } catch (e) {
      showError(e);
    }
  }, [selectedGroup, selectedPathKeysArr, showError]);

  const onPasteTemplateNodes = useCallback(async () => {
    if (!store || !selectedGroup || selectedGroup.isMaster) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      showError(e);
      return;
    }
    const parsed = parseClipboardNodes(text);
    if (!parsed?.length) {
      showError("В буфере нет списка шаблонов Snipcast (JSON-массив узлов).");
      return;
    }
    const next = cloneStore(store);
    const g = next.groups.find((x) => x.id === selectedGroup.id);
    if (!g) return;
    const insertPath = primaryPath;
    let insertAt: number;
    if (!insertPath || insertPath.length === 0) {
      insertAt = g.items.length;
    } else {
      insertAt = insertPath[insertPath.length - 1]! + 1;
    }
    const parentPath = insertPath?.slice(0, -1) ?? [];
    const fresh = parsed.map(remapNodeIds);
    insertManyAfterSelection(g.items, insertPath, fresh);
    try {
      await persistStore(next);
      const newKeys = fresh.map((_, i) => pathKey([...parentPath, insertAt + i]));
      setSelectedPathKeysArr(newKeys);
      setPrimaryPath(pathsFromKey(newKeys[0]!));
    } catch (e) {
      showError(e);
    }
  }, [store, selectedGroup, primaryPath, persistStore, showError]);

  useEffect(() => {
    if (section !== "templates") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable=true]")) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === "KeyC") {
        e.preventDefault();
        void onCopyTemplateNodes();
        return;
      }
      if (mod && e.code === "KeyV") {
        e.preventDefault();
        void onPasteTemplateNodes();
        return;
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        if (selectedPathKeysArr.length === 0) return;
        e.preventDefault();
        void onDeleteNode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, onCopyTemplateNodes, onPasteTemplateNodes, onDeleteNode, selectedPathKeysArr.length]);

  const blockForNav = useMemo(() => selectionAsBlockStrict(selectedPathKeySet), [selectedPathKeySet]);

  const navListForBlock = useMemo(() => {
    if (!selectedGroup || !blockForNav) return null;
    return getListAtParent(selectedGroup.items, blockForNav.parentPath);
  }, [selectedGroup, blockForNav]);

  const canMoveSingleUp = useMemo(() => {
    if (!selectedGroup || !primaryPath || selectedGroup.isMaster) return false;
    if (selectedPathKeysArr.length !== 1) return false;
    const parentPath = primaryPath.slice(0, -1);
    const idx = primaryPath[primaryPath.length - 1]!;
    const list = getListAtParent(selectedGroup.items, parentPath);
    if (!list) return false;
    if (idx > 0) return true;
    return parentPath.length > 0;
  }, [selectedGroup, primaryPath, selectedPathKeysArr.length]);

  const canMoveSingleDown = useMemo(() => {
    if (!selectedGroup || !primaryPath || selectedGroup.isMaster) return false;
    if (selectedPathKeysArr.length !== 1) return false;
    const parentPath = primaryPath.slice(0, -1);
    const idx = primaryPath[primaryPath.length - 1]!;
    const list = getListAtParent(selectedGroup.items, parentPath);
    if (!list) return false;
    if (idx < list.length - 1) return true;
    return parentPath.length > 0;
  }, [selectedGroup, primaryPath, selectedPathKeysArr.length]);

  const canMoveUp =
    !selectedGroup?.isMaster &&
    (selectedPathKeysArr.length === 1
      ? canMoveSingleUp
      : !!(blockForNav && navListForBlock && blockForNav.start > 0));
  const canMoveDown =
    !selectedGroup?.isMaster &&
    (selectedPathKeysArr.length === 1
      ? canMoveSingleDown
      : !!(blockForNav && navListForBlock && blockForNav.end < navListForBlock.length - 1));

  const onTreeRowClick = (path: number[], e: ReactMouseEvent) => {
    const rk = pathKey(path);
    if (e.ctrlKey || e.metaKey) {
      setSelectedPathKeysArr((prev) => {
        const s = new Set(prev);
        if (s.has(rk)) s.delete(rk);
        else s.add(rk);
        return [...s];
      });
      setPrimaryPath(path);
    } else {
      setSelectedPathKeysArr([rk]);
      setPrimaryPath(path);
    }
  };

  const renderTree = (items: TemplateNode[], basePath: number[], depth: number): ReactNode =>
    items.map((item, i) => {
      const path = [...basePath, i];
      const rowKeyStr = pathKey(path);
      const key =
        item.type === "template"
          ? `t-${item.id}`
          : item.type === "folder"
            ? `f-${item.id}`
            : `s-${item.id}`;
      const isPrimary = pathsEqual(primaryPath, path);
      const isSelected = selectedPathKeySet.has(rowKeyStr);
      const label =
        item.type === "template"
          ? item.title
          : item.type === "folder"
            ? item.title
            : "— разделитель —";
      return (
        <div key={key} className="settings__tree-node">
          <button
            type="button"
            className={`settings__tree-row${isSelected ? " is-selected" : ""}${isPrimary ? " is-active" : ""}`}
            style={{ paddingLeft: 10 + depth * 18 }}
            onClick={(e) => onTreeRowClick(path, e)}
          >
            {item.type === "folder" ? (
              <span
                className="settings__tree-toggle"
                role="button"
                tabIndex={0}
                aria-label={collapsedFolders.has(rowKeyStr) ? "Развернуть подпункт" : "Свернуть подпункт"}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsedFolders((prev) => {
                    const next = new Set(prev);
                    if (next.has(rowKeyStr)) next.delete(rowKeyStr);
                    else next.add(rowKeyStr);
                    return next;
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  setCollapsedFolders((prev) => {
                    const next = new Set(prev);
                    if (next.has(rowKeyStr)) next.delete(rowKeyStr);
                    else next.add(rowKeyStr);
                    return next;
                  });
                }}
              >
                {collapsedFolders.has(rowKeyStr) ? "▸" : "▾"}
              </span>
            ) : null}
            {item.type === "folder" ? (
              <span className="settings__tree-icon" aria-hidden>
                📂
              </span>
            ) : null}
            {item.type === "separator" ? <span className="settings__tree-sep-label">{label}</span> : label}
          </button>
          {item.type === "folder" && !collapsedFolders.has(rowKeyStr) ? renderTree(item.items, path, depth + 1) : null}
        </div>
      );
    });

  return (
    <div className="settings" onContextMenu={(e) => e.preventDefault()}>
      <aside className="settings__sidebar" style={{ width: navWidth }}>
        <div className="settings__brand">Snipcast</div>
        <nav className="settings__nav">
          <button
            type="button"
            className={section === "general" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("general")}
          >
            <IconSliders className="settings__nav-icon" />
            Основные
          </button>
          <button
            type="button"
            className={section === "screenshot" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("screenshot")}
          >
            <IconCamera className="settings__nav-icon" />
            Скриншот
          </button>
          <button
            type="button"
            className={section === "ai" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("ai")}
          >
            <IconSpark className="settings__nav-icon" />
            ИИ
          </button>
          <button
            type="button"
            className={section === "templates" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("templates")}
          >
            <IconLayers className="settings__nav-icon" />
            Шаблоны
          </button>
          <button
            type="button"
            className={section === "variables" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("variables")}
          >
            <IconBraces className="settings__nav-icon" />
            Переменные
          </button>
          <button
            type="button"
            className={section === "update" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("update")}
          >
            <IconRefresh className="settings__nav-icon" />
            Обновление
          </button>
        </nav>
      </aside>

      <div
        className="settings__splitter"
        role="separator"
        aria-orientation="vertical"
        title="Потяните, чтобы изменить ширину панели"
        onPointerDown={onSplitterPointerDown}
        onPointerMove={onSplitterPointerMove}
        onPointerUp={onSplitterPointerUp}
      />

      <main className="settings__main">
        {errorToast ? <div className="settings__toast settings__toast--error">{errorToast}</div> : null}

        {loadErrors.length ? (
          <div className="settings__banner settings__banner--error" role="alert">
            <strong>Часть данных не загрузилась.</strong> Изменения в этих разделах не сохранятся,
            пока причина не устранена: {loadErrors.join("; ")}
          </div>
        ) : null}

        {section === "general" ? (
          <div className="settings__panel">
            <div className="settings__group">
              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Тема</span>
                <div className="settings__segment-row" role="radiogroup" aria-label="Тема оформления">
                  {(
                    [
                      { v: "light" as const, label: "Светлая" },
                      { v: "dark" as const, label: "Тёмная" },
                      { v: "system" as const, label: "Как в системе" },
                    ] as const
                  ).map(({ v, label }) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={normalizeUiTheme(config?.theme) === v}
                      className={`settings__seg${normalizeUiTheme(config?.theme) === v ? " is-active" : ""}`}
                      onClick={() => void patchAppConfig({ theme: v })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Размер шрифта в списке шаблонов</span>
                <div className="settings__segment-row" role="radiogroup" aria-label="Размер списка в палитре">
                  {(
                    [
                      { v: "compact" as const, label: "Мелкий" },
                      { v: "normal" as const, label: "Обычный" },
                    ] as const
                  ).map(({ v, label }) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={normalizePaletteListDensity(config?.paletteListDensity) === v}
                      className={`settings__seg${
                        normalizePaletteListDensity(config?.paletteListDensity) === v ? " is-active" : ""
                      }`}
                      onClick={() => void patchAppConfig({ paletteListDensity: v })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings__option">
                <span className="settings__option-label">Автозапуск с системой</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autostartOn}
                  className={`settings__toggle${autostartOn ? " is-on" : ""}`}
                  onClick={() => void onAutostartToggle(!autostartOn)}
                >
                  <span className="settings__toggle-knob" />
                </button>
              </div>
              <div className="settings__option settings__option--hotkey">
                <span className="settings__option-label">Хоткей</span>
                <input
                  type="text"
                  readOnly
                  className="settings__hotkey-input"
                  value={hotkeyDisplay}
                  onFocus={onHotkeyFocus}
                  onBlur={onHotkeyBlur}
                  onKeyDown={(e) => void onHotkeyKeyDown(e)}
                  placeholder={
                    hotkeyDisplay ? "" : "Не назначен — открывайте из трея"
                  }
                  spellCheck={false}
                  aria-label="Запись хоткея палитры"
                />
                <button
                  type="button"
                  className="settings__ghost"
                  disabled={!hotkeyDisplay.trim()}
                  onClick={() => void onClearPaletteHotkey()}
                >
                  Очистить
                </button>
              </div>

              <div className="settings__option settings__option--hotkey">
                <span className="settings__option-label">Хоткей скриншота</span>
                <input
                  type="text"
                  readOnly
                  className="settings__hotkey-input"
                  value={screenshotHotkeyDisplay}
                  onFocus={onScreenshotHotkeyFocus}
                  onBlur={onScreenshotHotkeyBlur}
                  onKeyDown={(e) => void onScreenshotHotkeyKeyDown(e)}
                  placeholder={
                    screenshotHotkeyCapturing
                      ? "Нажмите сочетание…"
                      : screenshotHotkeyDisplay
                        ? ""
                        : "Не назначен — доступно из трея"
                  }
                  spellCheck={false}
                  aria-label="Запись хоткея скриншота"
                />
                <button
                  type="button"
                  className="settings__ghost"
                  disabled={!screenshotHotkeyDisplay.trim()}
                  onClick={() => void onClearScreenshotHotkey()}
                >
                  Очистить
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {section === "screenshot" && config ? (
          <div className="settings__panel">
            <div className="settings__group">
              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Формат файла</span>
                <div className="settings__segment-row" role="radiogroup" aria-label="Формат файла скриншота">
                  {(
                    [
                      { v: "png" as const, label: "PNG" },
                      { v: "jpeg" as const, label: "JPEG" },
                    ] as const
                  ).map(({ v, label }) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={config.screenshotFormat === v}
                      className={`settings__seg${config.screenshotFormat === v ? " is-active" : ""}`}
                      onClick={() => void patchAppConfig({ screenshotFormat: v })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {config.screenshotFormat === "jpeg" ? (
                  <label className="settings__range-row">
                    <span>Качество</span>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      step={1}
                      value={jpegQualityDraft}
                      onChange={(e) => setJpegQualityDraft(Number(e.target.value))}
                      aria-label="Качество JPEG"
                    />
                    <span className="settings__range-value">{jpegQualityDraft}</span>
                  </label>
                ) : null}
              </div>

              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Шаблон имени файла</span>
                <input
                  type="text"
                  value={fileTemplateDraft}
                  onChange={(e) => setFileTemplateDraft(e.target.value)}
                  placeholder="{datetime}"
                  spellCheck={false}
                  aria-label="Шаблон имени файла скриншота"
                />
                <p className="settings__screenshot-muted">
                  Доступные подстановки: {"{date}"}, {"{time}"}, {"{datetime}"}, {"{n}"}
                </p>
              </div>

              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Папка по умолчанию</span>
                <div className="settings__path-field">
                  <input
                    type="text"
                    readOnly
                    value={config.screenshotSaveDir}
                    placeholder="Не выбрана — открывается диалог"
                    spellCheck={false}
                    aria-label="Папка для сохранения скриншотов по умолчанию"
                  />
                  <button
                    type="button"
                    className="settings__folder-btn"
                    onClick={() => void pickScreenshotSaveDir()}
                  >
                    Выбрать…
                  </button>
                  <button
                    type="button"
                    className="settings__ghost"
                    disabled={!config.screenshotSaveDir}
                    onClick={() => void patchAppConfig({ screenshotSaveDir: "" })}
                  >
                    Сбросить
                  </button>
                </div>
              </div>

              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Быстрые места сохранения</span>
                {quickLocationsDraft.length === 0 ? (
                  <p className="settings__screenshot-muted">
                    Пока нет папок — удерживайте «Сохранить» в скриншоте, чтобы выбрать из списка
                  </p>
                ) : (
                  <div className="settings__quick-list">
                    {quickLocationsDraft.map((q, i) => (
                      <div key={`${q.path}-${i}`} className="settings__quick-row">
                        <input
                          type="text"
                          className="settings__quick-name-input"
                          value={q.name}
                          onChange={(e) => renameQuickLocation(i, e.target.value)}
                          spellCheck={false}
                          aria-label="Название быстрого места"
                        />
                        <span className="settings__quick-path" title={q.path}>
                          {q.path}
                        </span>
                        <button
                          type="button"
                          className="settings__ghost"
                          aria-label={`Удалить «${q.name}»`}
                          onClick={() => void removeQuickLocation(i)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <button
                    type="button"
                    className="settings__ghost"
                    disabled={quickLocationsDraft.length >= MAX_QUICK_LOCATIONS}
                    onClick={() => void addQuickLocation()}
                  >
                    Добавить папку…
                  </button>
                </div>
              </div>

              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Распознавание текста (OCR)</span>
                <div className="settings__segment-row" role="radiogroup" aria-label="Движок распознавания текста">
                  {(
                    [
                      { v: "system" as const, label: "Системный" },
                      { v: "paddle" as const, label: "PaddleOCR" },
                    ] as const
                  ).map(({ v, label }) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={config.screenshotOcrEngine === v}
                      className={`settings__seg${config.screenshotOcrEngine === v ? " is-active" : ""}`}
                      onClick={() => void patchAppConfig({ screenshotOcrEngine: v })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings__option">
                <span className="settings__option-label">Язык</span>
                <select
                  className="settings__select"
                  value={config.screenshotOcrLanguage || "auto"}
                  onChange={(e) => void patchAppConfig({ screenshotOcrLanguage: e.target.value })}
                  aria-label="Язык распознавания текста (системный OCR)"
                >
                  <option value="auto">Как в системе</option>
                    <option value="all">Все языки Windows (медленнее)</option>
                  {ocrLanguages.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </div>

              {config.screenshotOcrEngine === "paddle" ? (
                IS_MAC ? (
                  <p className="settings__screenshot-muted">PaddleOCR пока доступен только в Windows</p>
                ) : (
                  <div className="settings__option settings__option--stack">
                    <span className="settings__option-label">PaddleOCR · точность моделей</span>
                    <div className="settings__segment-row" role="radiogroup" aria-label="Точность моделей PaddleOCR">
                      {(
                        [
                          { v: "mobile" as const, label: "Быстрая" },
                          { v: "server" as const, label: "Точная" },
                        ] as const
                      ).map(({ v, label }) => (
                        <button
                          key={v}
                          type="button"
                          role="radio"
                          aria-checked={(config.screenshotOcrQuality || "mobile") === v}
                          className={`settings__seg${(config.screenshotOcrQuality || "mobile") === v ? " is-active" : ""}`}
                          onClick={() => {
                            void patchAppConfig({ screenshotOcrQuality: v }).then(() => {
                              void invoke<OcrModelsStatus>("snipcast_ocr_models_status")
                                .then(setPaddleStatus)
                                .catch(() => {});
                            });
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="settings__screenshot-muted">
                      «Точная»: серверные детектор и модель zh/en/ja (+~170 МБ докачки,
                      заметно медленнее — десятки секунд на весь экран). Кириллическая
                      модель всегда лёгкая: серверной версии не существует.
                    </p>
                    {paddleStatus?.installed ? (
                      <p className="settings__screenshot-status-ok">
                        Модели загружены (det + rec)
                      </p>
                    ) : (
                      <div className="settings__screenshot-actions">
                        <button
                          type="button"
                          className="settings__primary"
                          disabled={paddleDownloading}
                          onClick={() => void onDownloadOcrModels()}
                        >
                          {typeof paddleStatus?.downloadMb === "number"
                            ? `Скачать модели (~${paddleStatus.downloadMb} МБ)`
                            : "Скачать модели"}
                        </button>
                        {paddleDownloading ? (
                          <span className="settings__screenshot-progress">
                            {!paddleProgress
                              ? "Начинаю загрузку…"
                              : paddleProgress.total > 0
                                ? `${paddleProgress.message} — ${Math.min(100, Math.round((paddleProgress.done / paddleProgress.total) * 100))}%`
                                : paddleProgress.message}
                          </span>
                        ) : null}
                      </div>
                    )}
                    {paddleError ? (
                      <p className="settings__screenshot-status-error">{paddleError}</p>
                    ) : null}
                  </div>
                )
              ) : null}
            </div>

            <div className="settings__group">
              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Пресеты быстрого скриншота</span>
                <p className="settings__screenshot-muted">
                  Хоткей или трей → снимок в заданную папку с нужным именем. В режиме выделения
                  действие выполнится сразу после того, как вы нарисуете рамку.
                </p>
                {presetsDraft.length === 0 ? (
                  <p className="settings__screenshot-muted">
                    Пресетов нет — добавьте, чтобы сохранять скриншоты одной комбинацией
                  </p>
                ) : (
                  <div className="settings__preset-list">
                    {presetsDraft.map((p, i) => (
                      <div key={i} className="settings__preset">
                        <div className="settings__preset-top">
                          <input
                            type="text"
                            className="settings__preset-title"
                            value={p.title}
                            onChange={(e) => updatePreset(i, { title: e.target.value })}
                            placeholder="Название"
                            spellCheck={false}
                            aria-label="Название пресета"
                          />
                          <input
                            type="text"
                            readOnly
                            className="settings__hotkey-input settings__preset-hotkey"
                            value={tauriHotkeyToDisplay(p.hotkey)}
                            onFocus={() => onPresetHotkeyFocus(i)}
                            onBlur={onPresetHotkeyBlur}
                            onKeyDown={(e) => void onPresetHotkeyKeyDown(i, e)}
                            placeholder={
                              presetHotkeyCapturing === i
                                ? "Нажмите сочетание…"
                                : p.hotkey
                                  ? ""
                                  : "Не назначен"
                            }
                            spellCheck={false}
                            aria-label={`Хоткей пресета «${p.title}»`}
                          />
                          <button
                            type="button"
                            className="settings__ghost"
                            disabled={!p.hotkey.trim()}
                            onClick={() => void clearPresetHotkey(i)}
                          >
                            Очистить
                          </button>
                          <button
                            type="button"
                            className="settings__ghost"
                            aria-label={`Удалить пресет «${p.title}»`}
                            onClick={() => removePreset(i)}
                          >
                            Удалить
                          </button>
                        </div>
                        <p className="settings__preset-hint">
                          Пустой хоткей — запуск из трея и через API.
                        </p>
                        <div className="settings__path-field">
                          <input
                            type="text"
                            readOnly
                            value={p.dir}
                            placeholder="Общая папка"
                            spellCheck={false}
                            aria-label={`Папка пресета «${p.title}»`}
                          />
                          <button
                            type="button"
                            className="settings__folder-btn"
                            onClick={() => void pickPresetDir(i)}
                          >
                            Выбрать…
                          </button>
                          <button
                            type="button"
                            className="settings__ghost"
                            disabled={!p.dir}
                            onClick={() => updatePreset(i, { dir: "" })}
                          >
                            Сбросить
                          </button>
                        </div>
                        <input
                          type="text"
                          className="settings__preset-template"
                          value={p.fileTemplate}
                          onChange={(e) => updatePreset(i, { fileTemplate: e.target.value })}
                          placeholder="Общий шаблон"
                          spellCheck={false}
                          aria-label={`Шаблон имени файла пресета «${p.title}»`}
                        />
                        <p className="settings__preset-hint">
                          {"{date}"}, {"{time}"}, {"{datetime}"}, {"{n}"}
                        </p>
                        <div className="settings__preset-segs">
                          <div className="settings__preset-seg">
                            <span className="settings__field-label">Действие</span>
                            <div className="settings__segment-row" role="radiogroup" aria-label="Действие пресета">
                              {(
                                [
                                  { v: "save" as const, label: "Сохранить" },
                                  { v: "ocr" as const, label: "Сохранить + текст" },
                                  { v: "pin" as const, label: "Закрепить" },
                                ] as const
                              ).map(({ v, label }) => (
                                <button
                                  key={v}
                                  type="button"
                                  role="radio"
                                  aria-checked={p.action === v}
                                  className={`settings__seg${p.action === v ? " is-active" : ""}`}
                                  onClick={() => updatePreset(i, { action: v })}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="settings__preset-seg">
                            <span className="settings__field-label">Режим</span>
                            <div className="settings__segment-row" role="radiogroup" aria-label="Режим пресета">
                              {(
                                [
                                  { v: true as const, label: "Выделение области" },
                                  { v: false as const, label: "Весь экран" },
                                ] as const
                              ).map(({ v, label }) => (
                                <button
                                  key={v ? "select" : "full"}
                                  type="button"
                                  role="radio"
                                  aria-checked={p.select === v}
                                  className={`settings__seg${p.select === v ? " is-active" : ""}`}
                                  onClick={() => updatePreset(i, { select: v })}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <button
                    type="button"
                    className="settings__ghost"
                    disabled={presetsDraft.length >= MAX_SCREENSHOT_PRESETS}
                    onClick={addPreset}
                  >
                    Добавить пресет
                  </button>
                </div>
              </div>
            </div>

            <div className="settings__group">
              <div className="settings__option">
                <span className="settings__option-label">Внешний API (для скриптов)</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config.apiEnabled}
                  aria-label="Включить внешний API"
                  className={`settings__toggle${config.apiEnabled ? " is-on" : ""}`}
                  onClick={() => void onApiToggle(!config.apiEnabled)}
                >
                  <span className="settings__toggle-knob" />
                </button>
              </div>
              {config.apiEnabled ? (
                <div className="settings__api">
                  <div className="settings__option">
                    <span className="settings__option-label">Порт</span>
                    <input
                      type="number"
                      className="settings__api-port"
                      min={1024}
                      max={65535}
                      value={apiPortDraft}
                      onChange={(e) => setApiPortDraft(e.target.value)}
                      aria-label="Порт внешнего API"
                    />
                  </div>
                  {apiPortInvalid ? (
                    <p className="settings__screenshot-status-error">
                      Порт должен быть числом от 1024 до 65535
                    </p>
                  ) : (
                    <p className="settings__screenshot-muted">
                      Перезапуск приложения не требуется — сервер перезапустится сам.
                    </p>
                  )}
                  {apiError ? (
                    <p className="settings__screenshot-status-error">{apiError}</p>
                  ) : apiStatus ? (
                    apiStatus.running ? (
                      <p className="settings__screenshot-status-ok">
                        Работает на 127.0.0.1:{apiStatus.port}
                      </p>
                    ) : (
                      <p className="settings__screenshot-status-error">Не запущен</p>
                    )
                  ) : null}
                  {apiStatus ? (
                    <div className="settings__api-token-row">
                      <span className="settings__api-token" title={apiTokenVisible ? apiStatus.token : ""}>
                        {apiTokenVisible ? apiStatus.token : "••••••••••••"}
                      </span>
                      <button
                        type="button"
                        className="settings__ghost"
                        onClick={() => setApiTokenVisible((v) => !v)}
                      >
                        {apiTokenVisible ? "Скрыть" : "Показать"}
                      </button>
                      <button
                        type="button"
                        className="settings__ghost"
                        onClick={() => void copyApiToken()}
                      >
                        {apiTokenCopied ? "Скопировано" : "Копировать"}
                      </button>
                      <button
                        type="button"
                        className="settings__ghost"
                        onClick={() => void regenerateApiToken()}
                      >
                        Перевыпустить
                      </button>
                      {apiRegenHint ? (
                        <span className="settings__screenshot-muted">
                          старый токен больше не работает
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <pre className="settings__api-code">
{`POST http://127.0.0.1:${apiStatus?.port ?? config.apiPort}/capture  ·  заголовок X-Snipcast-Token  ·  GET /health — без токена`}
{apiStatus?.tokenPath ? `\nТокен хранится в файле ${apiStatus.tokenPath}` : ""}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {section === "ai" && config ? (
          <div className="settings__panel">
            <div className="settings__group">
              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Провайдер Polza (polza.ai)</span>
                <p className="settings__screenshot-muted">
                  ИИ-агент отвечает на вопросы по выделенным областям экрана.
                  Ключ берётся на polza.ai.
                </p>
              </div>

              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">API-ключ</span>
                <input
                  type="text"
                  value={aiKeyFocused ? aiKeyDraft : maskAiKey(aiKeyDraft)}
                  onChange={(e) => setAiKeyDraft(e.target.value)}
                  onFocus={() => setAiKeyFocused(true)}
                  onBlur={() => setAiKeyFocused(false)}
                  placeholder="Ключ из polza.ai"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="API-ключ Polza"
                />
              </div>

              <div className="settings__option settings__option--stack">
                <span className="settings__option-label">Модель</span>
                <input
                  type="text"
                  value={aiModelDraft}
                  onChange={(e) => setAiModelDraft(e.target.value)}
                  placeholder="openai/gpt-6-luna"
                  spellCheck={false}
                  aria-label="Модель ИИ"
                />
                <p className="settings__screenshot-muted">Список моделей: polza.ai/models</p>
              </div>

              <div className="settings__option settings__option--stack">
                <div className="settings__screenshot-actions">
                  <button
                    type="button"
                    className="settings__ghost"
                    disabled={aiTesting}
                    onClick={() => void runAiTest()}
                  >
                    {aiTesting ? "Проверяю…" : "Проверить подключение"}
                  </button>
                </div>
                {aiTestOk === true ? (
                  <p className="settings__screenshot-status-ok">Подключение работает</p>
                ) : null}
                {aiTestOk === false ? (
                  <p className="settings__screenshot-status-error">{aiTestError}</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {section === "templates" ? (
          <div className="settings__panel settings__panel--user-templates">
            <div className="settings__templates-toolbar settings__templates-toolbar--groups">
              <div className="settings__templates-toolbar-row">
                <button type="button" className="settings__ghost" title="Создать новую группу" onClick={() => openGroupModal("create")}>
                  ⊕ Новая группа
                </button>
                <button
                  type="button"
                  className="settings__ghost"
                  title="Добавить новую группу из JSON (редактируемая копия)"
                  onClick={() => void importEditableTemplateFromFile()}
                >
                  ⏬ Импорт группы
                </button>
                <button
                  type="button"
                  className="settings__ghost"
                  title="Сохранить выбранную группу в JSON (не мастер)"
                  disabled={!selectedGroupId || !!selectedGroup?.isMaster}
                  onClick={() => void exportSelectedGroupToFile()}
                >
                  ⏫ Экспорт группы
                </button>
                <button type="button" className="settings__ghost" title="Импортировать мастер группу из файла" onClick={() => openGroupModal("master")}>
                  ⭐︎ Мастер группа
                </button>
                <button type="button" className="settings__ghost" title="Удалить выбранную группу" disabled={!selectedGroupId} onClick={() => void onDeleteGroup()}>
                  ❌
                </button>
                <button
                  type="button"
                  className="settings__ghost"
                  title="Сменить цвет выбранной группы"
                  disabled={!selectedGroupId}
                  onClick={() => colorInputRef.current?.click()}
                >
                  🎨
                </button>
                <input
                  ref={colorInputRef}
                  type="color"
                  className="settings__hidden-color"
                  value={selectedGroup?.color ?? "#5164f2"}
                  onChange={(e) => void updateSelectedGroup({ color: e.target.value })}
                />
              </div>
              <div className="settings__group-tags-row">
                <span className="settings__group-tags-label">Группы:</span>
                <div className="settings__group-tags">
                  {store?.groups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className={`settings__group-tag${selectedGroupId === g.id ? " is-active" : ""}`}
                      style={{ "--tag-color": g.color } as React.CSSProperties}
                      onClick={() => setSelectedGroup(g.id)}
                    >
                      {g.title}
                      {g.isMaster ? " •M" : ""}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="settings__templates-toolbar">
              <button type="button" className="settings__ghost" title="Добавить шаблон" disabled={selectedGroup?.isMaster} onClick={() => void onAddNode("template")}>
                ➕
              </button>
              <button type="button" className="settings__ghost" title="Добавить подпункт" disabled={selectedGroup?.isMaster} onClick={() => void onAddNode("folder")}>
                📂
              </button>
              <button type="button" className="settings__ghost" title="Добавить разделитель" disabled={selectedGroup?.isMaster} onClick={() => void onAddNode("separator")}>
                ➖
              </button>
              <button type="button" className="settings__ghost" title="Переместить вверх" disabled={!canMoveUp} onClick={() => void onMove(-1)}>
                ⬆️
              </button>
              <button type="button" className="settings__ghost" title="Переместить вниз" disabled={!canMoveDown} onClick={() => void onMove(1)}>
                ⬇️
              </button>
              <button
                type="button"
                className="settings__ghost"
                title="Удалить выбранные (Del, Ctrl+клик для нескольких)"
                disabled={selectedPathKeysArr.length === 0 || selectedGroup?.isMaster}
                onClick={() => void onDeleteNode()}
              >
                ❌
              </button>
            </div>

            <div className="settings__templates-split">
              <div className="settings__templates-list settings__templates-list--full">
                <div className="settings__templates-list-inner">
                  {selectedGroup ? (
                    selectedGroup.items.length === 0 ? (
                      <p className="settings__templates-empty">Список пуст. Добавьте шаблон.</p>
                    ) : (
                      renderTree(selectedGroup.items, [], 0)
                    )
                  ) : (
                    <p className="settings__templates-empty">Создайте группу шаблонов.</p>
                  )}
                </div>
              </div>
              <div className="settings__templates-editor">
                {selectedNode?.type === "template" ? (
                  <>
                    <label className="settings__field-label" htmlFor="tpl-title">
                      Название шаблона
                    </label>
                    <input
                      id="tpl-title"
                      type="text"
                      className="settings__templates-title-input"
                      value={editorTitle}
                      onChange={(e) => setEditorTitle(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={!!selectedGroup?.isMaster}
                    />
                    <label className="settings__field-label" htmlFor="tpl-body">
                      Содержимое
                    </label>
                    <textarea
                      id="tpl-body"
                      className="settings__templates-body"
                      value={editorContent}
                      onChange={(e) => setEditorContent(e.target.value)}
                      placeholder="Текст шаблона…"
                      spellCheck={false}
                      disabled={!!selectedGroup?.isMaster}
                    />
                    <div className="settings__templates-hint">
                      <p>
                        <code className="settings__hint-code">{"{...}"}</code> — вставляет переменную из настроек.
                      </p>
                      <p>
                        <code className="settings__hint-code">[...]</code> — вписывание своего текста перед вставкой.
                      </p>
                      <p>
                        <code className="settings__hint-code">[&quot;...&quot;]</code> — ссылка на файл.
                      </p>
                    </div>
                    {selectedGroup?.isMaster ? (
                      <p className="settings__templates-placeholder">Мастер группа: редактирование отключено.</p>
                    ) : null}
                  </>
                ) : selectedNode?.type === "folder" ? (
                  <>
                    <label className="settings__field-label" htmlFor="folder-title">
                      Название подпункта
                    </label>
                    <input
                      id="folder-title"
                      type="text"
                      className="settings__templates-title-input"
                      value={editorTitle}
                      onChange={(e) => setEditorTitle(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={!!selectedGroup?.isMaster}
                    />
                    <p className="settings__templates-placeholder settings__templates-folder-hint">
                      Вложенные шаблоны отображаются внутри этой папки в палитре.
                    </p>
                    {selectedGroup?.isMaster ? (
                      <p className="settings__templates-placeholder">Мастер группа: редактирование отключено.</p>
                    ) : null}
                  </>
                ) : (
                  <p className="settings__templates-placeholder">Выберите шаблон или подпункт в списке слева.</p>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {section === "variables" ? (
          <div className="settings__panel">
            <div className="settings__vars">
              {varRows.map((row, i) => (
                <div key={i} className="settings__var-row">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => {
                      const next = [...varRows];
                      next[i] = { ...next[i], key: e.target.value };
                      setVarRows(next);
                    }}
                    placeholder="ключ"
                  />
                  <input
                    type="text"
                    value={row.value}
                    onChange={(e) => {
                      const next = [...varRows];
                      next[i] = { ...next[i], value: e.target.value };
                      setVarRows(next);
                    }}
                    placeholder="значение"
                  />
                  <button
                    type="button"
                    className="settings__ghost"
                    onClick={() => setVarRows(varRows.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="settings__ghost"
                onClick={() => setVarRows([...varRows, { key: "", value: "" }])}
              >
                + Строка
              </button>
            </div>
          </div>
        ) : null}

        {section === "update" ? (
          <div className="settings__panel settings__panel--about">
            <img className="settings__logo" src={SNIPCAST_LOGO_SRC} alt="" width={96} height={96} />
            <h2 className="settings__appname">Snipcast</h2>
            <p className="settings__dev">dev by Maxat32, maxat322@gmail.com</p>
            <p className="settings__version">Версия {version || "…"}</p>

            {!updateWritable ? (
              <div className="settings__banner settings__banner--error" role="alert">
                Папка с программой недоступна для записи, автоматическое обновление не сработает.
                Перенесите Snipcast туда, куда можно писать без прав администратора.
              </div>
            ) : null}

            {updateState === "available" && updateInfo ? (
              <div className="settings__update">
                <p className="settings__update-head">
                  Доступна версия <strong>{updateInfo.latestVersion}</strong>, у вас{" "}
                  {updateInfo.currentVersion}
                </p>
                {updateInfo.notes ? (
                  <pre className="settings__update-notes">{updateInfo.notes}</pre>
                ) : null}
              </div>
            ) : null}

            {updateState === "uptodate" ? (
              <p className="settings__update-status">У вас последняя версия</p>
            ) : null}

            {updateState === "installing" ? (
              <p className="settings__update-status">{updateStageLabel(updateStage)}</p>
            ) : null}

            {updateError ? (
              <div className="settings__banner settings__banner--error" role="alert">
                {updateError}
              </div>
            ) : null}

            <button
              type="button"
              className="settings__primary"
              disabled={updateState === "checking" || updateState === "installing"}
              onClick={() =>
                void (updateState === "available" ? installUpdate() : checkUpdate())
              }
            >
              {updateState === "checking"
                ? "Проверяю…"
                : updateState === "installing"
                  ? "Обновляю…"
                  : updateState === "available"
                    ? `Обновить до ${updateInfo?.latestVersion ?? ""}`
                    : "Проверить обновления"}
            </button>

            <button
              type="button"
              className="settings__linkish"
              onClick={() => void openUrl(`${REPO_URL}/releases`)}
            >
              Все релизы на GitHub
            </button>
          </div>
        ) : null}

        {groupModalMode ? (
          <div className="settings__modal-backdrop" role="presentation" onClick={closeGroupModal}>
            <div
              className="settings__modal"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="settings__modal-title">
                {groupModalMode === "master" ? "Новая мастер группа" : "Новая группа"}
              </h3>
              {groupModalMode === "create" ? (
                <>
                  <label className="settings__field-label" htmlFor="group-name-input">
                    Название группы
                  </label>
                  <input
                    id="group-name-input"
                    type="text"
                    value={groupModalName}
                    onChange={(e) => setGroupModalName(e.target.value)}
                    autoFocus
                  />
                </>
              ) : (
                <div className="settings__path-field">
                  <input
                    id="group-master-path-display"
                    type="text"
                    readOnly
                    value={groupModalPath}
                    placeholder="Нажмите «Обзор…» и выберите файл"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    id="group-master-file-btn"
                    className="settings__folder-btn"
                    onClick={() => void pickMasterGroupFile()}
                  >
                    Обзор…
                  </button>
                </div>
              )}
              <div className="settings__modal-actions">
                <button type="button" className="settings__ghost" onClick={closeGroupModal}>
                  Отмена
                </button>
                <button type="button" className="settings__primary" onClick={() => void onConfirmGroupModal()}>
                  {groupModalMode === "master" ? "Импорт" : "Создать"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
import type { PointerEvent as ReactPointerEvent } from "react";
