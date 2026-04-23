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
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { keyboardEventToTauriHotkey, tauriHotkeyToDisplay } from "./hotkeyFormat";
import type { AppConfig, TemplateGroup, TemplateNode, TemplateStore } from "./types";
import {
  applyPaletteListDensity,
  applyUiThemeSetting,
  normalizePaletteListDensity,
  normalizeUiTheme,
} from "./uiTheme";
import { SNIPCAST_LOGO_SRC } from "./branding";
import "./theme-overrides.css";
import "./Settings.css";

const REPO_URL = "https://github.com/maxat32/Snipcast";
const GROUP_COLORS = ["#5164f2", "#e8590c", "#20c997", "#be4bdb", "#339af0", "#fa5252"];

type Section = "general" | "templates" | "variables" | "update";
type GroupModalMode = "create" | "master" | null;

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

export function SettingsApp() {
  const [section, setSection] = useState<Section>("general");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const configRef = useRef<AppConfig | null>(null);
  configRef.current = config;

  const [autostartOn, setAutostartOn] = useState(true);
  const [hotkeyDisplay, setHotkeyDisplay] = useState("");
  const [errorToast, setErrorToast] = useState("");
  const [version, setVersion] = useState("");
  const [varRows, setVarRows] = useState<{ key: string; value: string }[]>([]);

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
    async (patch: Partial<Pick<AppConfig, "theme" | "paletteListDensity">>) => {
      if (!config) return;
      const next: AppConfig = { ...config, ...patch };
      setConfig(next);
      if ("theme" in patch) applyUiThemeSetting(normalizeUiTheme(next.theme));
      if ("paletteListDensity" in patch) {
        applyPaletteListDensity(normalizePaletteListDensity(next.paletteListDensity));
      }
      try {
        await saveConfig(next, { skipPaletteHotkeyApply: true });
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
    try {
      const [c, v, vars, tmpl] = await Promise.all([
        invoke<AppConfig>("snipcast_get_config"),
        invoke<string>("snipcast_get_version"),
        invoke<Record<string, unknown>>("snipcast_get_variables"),
        invoke<TemplateStore>("snipcast_get_template_store"),
      ]);
      setConfig(c);
      applyUiThemeSetting(normalizeUiTheme(c.theme));
      applyPaletteListDensity(normalizePaletteListDensity(c.paletteListDensity));
      setHotkeyDisplay(tauriHotkeyToDisplay(c.paletteHotkey));
      setVersion(v);
      const enabled = await isEnabled().catch(() => false);
      setAutostartOn(enabled);
      const rows = Object.entries(vars).map(([key, val]) => ({
        key,
        value: typeof val === "string" ? val : JSON.stringify(val),
      }));
      setVarRows(rows.length ? rows : [{ key: "", value: "" }]);
      setStore(tmpl);
      setSelectedGroupId((prev) => prev ?? tmpl.groups[0]?.id ?? null);
    } catch (e) {
      showError(e);
    }
  }, [showError]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
    const t = window.setTimeout(() => {
      const map: Record<string, unknown> = {};
      for (const r of varRows) {
        const k = r.key.trim();
        if (!k) continue;
        map[k] = r.value;
      }
      void invoke("snipcast_save_variables", { map }).catch(showError);
    }, 500);
    return () => clearTimeout(t);
  }, [varRows, showError]);

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
      <aside className="settings__sidebar">
        <div className="settings__brand">Snipcast</div>
        <nav className="settings__nav">
          <button
            type="button"
            className={section === "general" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("general")}
          >
            Основные
          </button>
          <button
            type="button"
            className={section === "templates" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("templates")}
          >
            Шаблоны
          </button>
          <button
            type="button"
            className={section === "variables" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("variables")}
          >
            Переменные
          </button>
          <button
            type="button"
            className={section === "update" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("update")}
          >
            Обновление
          </button>
        </nav>
      </aside>

      <main className="settings__main">
        {errorToast ? <div className="settings__toast settings__toast--error">{errorToast}</div> : null}

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
                  placeholder="Нажмите комбинацию клавиш"
                  spellCheck={false}
                  aria-label="Запись хоткея палитры"
                />
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
                        <code className="settings__hint-code">[...]</code> — вписывание своего текста, перед вставкой.
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
            <button
              type="button"
              className="settings__primary"
              onClick={() => void openUrl(`${REPO_URL}/releases`)}
            >
              Проверить обновления (GitHub)
            </button>
            <button type="button" className="settings__linkish" onClick={() => void openUrl(REPO_URL)}>
              Репозиторий на GitHub
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
