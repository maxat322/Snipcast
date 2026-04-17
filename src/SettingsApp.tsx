import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { keyboardEventToTauriHotkey, tauriHotkeyToDisplay } from "./hotkeyFormat";
import type { AppConfig, TemplateGroup, TemplateNode, TemplateStore } from "./types";
import {
  applyPaletteListDensity,
  applyUiThemeSetting,
  normalizePaletteListDensity,
  normalizeUiTheme,
} from "./uiTheme";
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

function moveSelected(items: TemplateNode[], path: number[] | null, delta: -1 | 1): boolean {
  if (!path || path.length === 0) return false;
  const idx = path[path.length - 1]!;
  let list = items;
  for (let d = 0; d < path.length - 1; d++) {
    const node = list[path[d]!];
    if (!node || node.type !== "folder") return false;
    list = node.items;
  }
  const j = idx + delta;
  if (j < 0 || j >= list.length) return false;
  const a = list[idx]!;
  list[idx] = list[j]!;
  list[j] = a;
  return true;
}

function moveIntoFolderBelow(items: TemplateNode[], path: number[]): number[] | null {
  if (path.length === 0) return null;
  const idx = path[path.length - 1]!;
  let list = items;
  for (let d = 0; d < path.length - 1; d++) {
    const node = list[path[d]!];
    if (!node || node.type !== "folder") return null;
    list = node.items;
  }
  if (idx + 1 >= list.length) return null;
  const below = list[idx + 1];
  if (!below || below.type !== "folder") return null;
  const [moved] = list.splice(idx, 1);
  const folderNode = list[idx];
  if (!folderNode || folderNode.type !== "folder") return null;
  folderNode.items.unshift(moved);
  return [...path.slice(0, -1), idx, 0];
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
  const [selectedPath, setSelectedPath] = useState<number[] | null>(null);
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

  const selectedNode = useMemo(() => {
    if (!selectedGroup || !selectedPath) return null;
    return getNodeAtPath(selectedGroup.items, selectedPath);
  }, [selectedGroup, selectedPath]);

  useEffect(() => {
    if (!selectedNode || selectedNode.type !== "template") {
      setEditorTitle("");
      setEditorContent("");
      return;
    }
    setEditorTitle(selectedNode.title);
    setEditorContent(selectedNode.content);
  }, [selectedNode?.type, selectedNode && selectedNode.type === "template" ? selectedNode.id : ""]);

  useEffect(() => {
    if (!store || !selectedGroup || !selectedPath || selectedGroup.isMaster) return;
    if (!selectedNode || selectedNode.type !== "template") return;
    const t = window.setTimeout(() => {
      const next = cloneStore(store);
      const g = next.groups.find((x) => x.id === selectedGroup.id);
      if (!g) return;
      const node = getNodeAtPath(g.items, selectedPath);
      if (!node || node.type !== "template") return;
      node.title = editorTitle;
      node.content = editorContent;
      void persistStore(next).catch(showError);
    }, 350);
    return () => clearTimeout(t);
  }, [
    editorTitle,
    editorContent,
    selectedPath,
    selectedNode && selectedNode.type === "template" ? selectedNode.id : "",
    selectedGroup?.id,
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
    setSelectedPath(null);
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
        setSelectedPath(null);
      } catch (e) {
        showError(e);
      }
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
    insertAfterSelection(g.items, selectedPath, node);
    try {
      await persistStore(next);
      if (!selectedPath || selectedPath.length === 0) {
        setSelectedPath([g.items.length - 1]);
      } else {
        const np = [...selectedPath];
        np[np.length - 1] = np[np.length - 1]! + 1;
        setSelectedPath(np);
      }
    } catch (e) {
      showError(e);
    }
  };

  const onMove = async (delta: -1 | 1) => {
    if (!store || !selectedGroup || !selectedPath || selectedGroup.isMaster) return;
    const next = cloneStore(store);
    const g = next.groups.find((x) => x.id === selectedGroup.id);
    if (!g) return;
    if (delta === 1) {
      const intoPath = moveIntoFolderBelow(g.items, selectedPath);
      if (intoPath) {
        try {
          await persistStore(next);
          setSelectedPath(intoPath);
          return;
        } catch (e) {
          showError(e);
          return;
        }
      }
    }
    if (!moveSelected(g.items, selectedPath, delta)) return;
    try {
      await persistStore(next);
      const np = [...selectedPath];
      np[np.length - 1] = np[np.length - 1]! + delta;
      setSelectedPath(np);
    } catch (e) {
      showError(e);
    }
  };

  const onDeleteNode = async () => {
    if (!store || !selectedGroup || !selectedPath || selectedGroup.isMaster) return;
    const next = cloneStore(store);
    const g = next.groups.find((x) => x.id === selectedGroup.id);
    if (!g) return;
    if (!removeSelected(g.items, selectedPath)) return;
    try {
      await persistStore(next);
      setSelectedPath(null);
      setEditorTitle("");
      setEditorContent("");
    } catch (e) {
      showError(e);
    }
  };

  const canMoveUp = !!selectedPath && selectedPath[selectedPath.length - 1]! > 0 && !selectedGroup?.isMaster;
  const canMoveDown =
    !!selectedGroup &&
    !!selectedPath &&
    !selectedGroup.isMaster &&
    (() => {
      let list = selectedGroup.items;
      for (let d = 0; d < selectedPath.length - 1; d++) {
        const n = list[selectedPath[d]!];
        if (!n || n.type !== "folder") return false;
        list = n.items;
      }
      const idx = selectedPath[selectedPath.length - 1]!;
      return idx < list.length - 1;
    })();

  const renderTree = (items: TemplateNode[], basePath: number[], depth: number): ReactNode =>
    items.map((item, i) => {
      const path = [...basePath, i];
      const pathKey = path.join(".");
      const key =
        item.type === "template"
          ? `t-${item.id}`
          : item.type === "folder"
            ? `f-${item.id}`
            : `s-${item.id}`;
      const active = pathsEqual(selectedPath, path);
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
            className={`settings__tree-row${active ? " is-active" : ""}`}
            style={{ paddingLeft: 10 + depth * 18 }}
            onClick={() => setSelectedPath(path)}
          >
            {item.type === "folder" ? (
              <span
                className="settings__tree-toggle"
                role="button"
                tabIndex={0}
                aria-label={collapsedFolders.has(pathKey) ? "Развернуть подпункт" : "Свернуть подпункт"}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsedFolders((prev) => {
                    const next = new Set(prev);
                    if (next.has(pathKey)) next.delete(pathKey);
                    else next.add(pathKey);
                    return next;
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  setCollapsedFolders((prev) => {
                    const next = new Set(prev);
                    if (next.has(pathKey)) next.delete(pathKey);
                    else next.add(pathKey);
                    return next;
                  });
                }}
              >
                {collapsedFolders.has(pathKey) ? "▸" : "▾"}
              </span>
            ) : null}
            {item.type === "folder" ? (
              <span className="settings__tree-icon" aria-hidden>
                📂
              </span>
            ) : null}
            {item.type === "separator" ? <span className="settings__tree-sep-label">{label}</span> : label}
          </button>
          {item.type === "folder" && !collapsedFolders.has(pathKey) ? renderTree(item.items, path, depth + 1) : null}
        </div>
      );
    });

  return (
    <div className="settings">
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
              <button type="button" className="settings__ghost" title="Импортировать мастер группу из файла" onClick={() => openGroupModal("master")}>
                ⭐︎ Мастер группа
              </button>
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
              <button type="button" className="settings__ghost" title="Удалить выбранный элемент" disabled={!selectedPath || selectedGroup?.isMaster} onClick={() => void onDeleteNode()}>
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
                        <code>{"{...}"}</code> — вставляет переменную из настроек.
                      </p>
                      <p>
                        <code>[...]</code> — вписывание своего текста, перед вставкой.
                      </p>
                    </div>
                    {selectedGroup?.isMaster ? (
                      <p className="settings__templates-placeholder">Мастер группа: редактирование отключено.</p>
                    ) : null}
                  </>
                ) : (
                  <p className="settings__templates-placeholder">Выберите шаблон в списке слева.</p>
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
            <img className="settings__logo" src="/app-icon.png" alt="" width={96} height={96} />
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
