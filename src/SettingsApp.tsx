import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { keyboardEventToTauriHotkey, tauriHotkeyToDisplay } from "./hotkeyFormat";
import type {
  AppConfig,
  PathsDto,
  UserStructureItem,
  UserStructureRoot,
  UserTxtReadDto,
  UserTxtWriteResultDto,
} from "./types";
import "./Settings.css";

const REPO_URL = "https://github.com/maxat32/Snipcast";

type Section = "general" | "master" | "user" | "variables" | "update";

function cloneStructure(root: UserStructureRoot): UserStructureRoot {
  return JSON.parse(JSON.stringify(root)) as UserStructureRoot;
}

function getNodeAtPath(root: UserStructureRoot, path: number[]): UserStructureItem | null {
  if (path.length === 0) return null;
  let list = root.items;
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

function insertAfterSelection(
  root: UserStructureRoot,
  selectedPath: number[] | null,
  item: UserStructureItem,
): UserStructureRoot {
  const next = cloneStructure(root);
  if (!selectedPath || selectedPath.length === 0) {
    next.items.push(item);
    return next;
  }
  const insertAt = selectedPath[selectedPath.length - 1]! + 1;
  const parentPath = selectedPath.slice(0, -1);
  let list = next.items;
  for (const idx of parentPath) {
    const node = list[idx];
    if (!node || node.type !== "folder") {
      next.items.push(item);
      return next;
    }
    list = node.items;
  }
  list.splice(insertAt, 0, item);
  return next;
}

function moveSelected(
  root: UserStructureRoot,
  path: number[] | null,
  delta: -1 | 1,
): UserStructureRoot | null {
  if (!path || path.length === 0) return null;
  const next = cloneStructure(root);
  const idx = path[path.length - 1]!;
  let list = next.items;
  for (let d = 0; d < path.length - 1; d++) {
    const node = list[path[d]!];
    if (!node || node.type !== "folder") return null;
    list = node.items;
  }
  const j = idx + delta;
  if (j < 0 || j >= list.length) return null;
  const a = list[idx]!;
  const b = list[j]!;
  list[idx] = b;
  list[j] = a;
  return next;
}

/** Если ниже выбранного элемента идёт папка — переносим элемент внутрь неё (в начало списка). */
function moveIntoFolderBelow(
  root: UserStructureRoot,
  path: number[],
): { root: UserStructureRoot; newPath: number[] } | null {
  if (path.length === 0) return null;
  const next = cloneStructure(root);
  const idx = path[path.length - 1]!;
  let list = next.items;
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
  const newPath = [...path.slice(0, -1), idx, 0];
  return { root: next, newPath };
}

function collectTxtFromSubtree(item: UserStructureItem): string[] {
  const out: string[] = [];
  const walk = (it: UserStructureItem) => {
    if (it.type === "template") out.push(it.file);
    else if (it.type === "folder") it.items.forEach(walk);
  };
  walk(item);
  return out;
}

function removeAtPath(
  root: UserStructureRoot,
  path: number[],
): { root: UserStructureRoot; txtToDelete: string[] } {
  const next = cloneStructure(root);
  const idx = path[path.length - 1]!;
  let list = next.items;
  for (let d = 0; d < path.length - 1; d++) {
    const node = list[path[d]!];
    if (!node || node.type !== "folder") {
      return { root: next, txtToDelete: [] };
    }
    list = node.items;
  }
  const removed = list[idx];
  if (!removed) return { root: next, txtToDelete: [] };
  const txtToDelete = collectTxtFromSubtree(removed);
  list.splice(idx, 1);
  return { root: next, txtToDelete };
}

function replaceTemplateFileInRoot(root: UserStructureRoot, oldFile: string, newFile: string) {
  const walk = (items: UserStructureItem[]) => {
    for (const it of items) {
      if (it.type === "template" && it.file === oldFile) it.file = newFile;
      else if (it.type === "folder") walk(it.items);
    }
  };
  walk(root.items);
}

function pathsEqual(a: number[] | null, b: number[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function saveConfig(
  next: AppConfig,
  opts?: { skipPaletteHotkeyApply?: boolean },
): Promise<void> {
  await invoke("snipcast_save_config", {
    incoming: next,
    skip_palette_hotkey_apply: opts?.skipPaletteHotkeyApply ?? false,
  });
}

export function SettingsApp() {
  const [section, setSection] = useState<Section>("general");
  const [paths, setPaths] = useState<PathsDto | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const configRef = useRef<AppConfig | null>(null);
  configRef.current = config;

  const [autostartOn, setAutostartOn] = useState(true);
  const [hotkeyDisplay, setHotkeyDisplay] = useState("");
  const [masterPathInput, setMasterPathInput] = useState("");
  const [errorToast, setErrorToast] = useState("");

  const [version, setVersion] = useState("");
  const [userStructure, setUserStructure] = useState<UserStructureRoot | null>(null);
  const [selectedPath, setSelectedPath] = useState<number[] | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const editorSnapshotRef = useRef<{ file: string; title: string; content: string } | null>(null);
  const [varRows, setVarRows] = useState<{ key: string; value: string }[]>([]);

  const showError = useCallback((e: unknown) => {
    setErrorToast(String(e));
    setTimeout(() => setErrorToast(""), 5000);
  }, []);

  const pickMasterFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Папка мастер-шаблонов",
      });
      if (selected === null) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === "string") setMasterPathInput(path);
    } catch (e) {
      showError(e);
    }
  }, [showError]);

  const loadAll = useCallback(async () => {
    try {
      const [p, c, v, vars] = await Promise.all([
        invoke<PathsDto>("snipcast_get_paths"),
        invoke<AppConfig>("snipcast_get_config"),
        invoke<string>("snipcast_get_version"),
        invoke<Record<string, unknown>>("snipcast_get_variables"),
      ]);
      setPaths(p);
      setConfig(c);
      setHotkeyDisplay(tauriHotkeyToDisplay(c.paletteHotkey));
      setMasterPathInput(c.masterTemplatesPath ?? "");
      setVersion(v);
      const enabled = await isEnabled().catch(() => false);
      setAutostartOn(enabled);
      const rows = Object.entries(vars).map(([key, val]) => ({
        key,
        value: typeof val === "string" ? val : JSON.stringify(val),
      }));
      setVarRows(rows.length ? rows : [{ key: "", value: "" }]);
    } catch (e) {
      showError(e);
    }
  }, [showError]);

  const loadUserStructure = useCallback(async () => {
    try {
      const s = await invoke<UserStructureRoot>("snipcast_get_user_structure");
      setUserStructure(s);
    } catch (e) {
      showError(e);
    }
  }, [showError]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (section !== "user") return;
    void loadUserStructure();
  }, [section, loadUserStructure]);

  const onAutostartToggle = async (on: boolean) => {
    setAutostartOn(on);
    try {
      if (on) await enable();
      else await disable();
    } catch {
      /* ignore */
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

  useEffect(() => {
    const base = configRef.current;
    if (!base) return;
    const t = window.setTimeout(() => {
      const v = masterPathInput.trim() || null;
      const cur = base.masterTemplatesPath ?? null;
      if (v === cur) return;
      const next = { ...base, masterTemplatesPath: v };
      void saveConfig(next)
        .then(() => setConfig(next))
        .catch(showError);
    }, 450);
    return () => clearTimeout(t);
  }, [masterPathInput, showError]);

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

  const persistStructure = useCallback(
    async (next: UserStructureRoot) => {
      await invoke("snipcast_save_user_structure", { root: next });
      setUserStructure(next);
    },
    [],
  );

  const applySelection = useCallback(
    async (path: number[], root: UserStructureRoot) => {
      setSelectedPath(path);
      const node = getNodeAtPath(root, path);
      if (node?.type === "template") {
        try {
          const dto = await invoke<UserTxtReadDto>("snipcast_read_user_template_txt", {
            file: node.file,
          });
          setEditingFile(dto.file);
          setEditorTitle(dto.title);
          setEditorContent(dto.content);
          editorSnapshotRef.current = {
            file: dto.file,
            title: dto.title,
            content: dto.content,
          };
        } catch (e) {
          showError(e);
        }
      } else {
        setEditingFile(null);
        setEditorTitle("");
        setEditorContent("");
        editorSnapshotRef.current = null;
      }
    },
    [showError],
  );

  const selectPath = useCallback(
    async (path: number[]) => {
      if (!userStructure) return;
      await applySelection(path, userStructure);
    },
    [userStructure, applySelection],
  );

  useEffect(() => {
    if (!editingFile || section !== "user") return;
    const oldFile = editingFile;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await invoke<UserTxtWriteResultDto>("snipcast_write_user_template_txt", {
            oldFile,
            title: editorTitle,
            content: editorContent,
          });
          if (res.file !== oldFile) {
            setUserStructure((prev) => {
              if (!prev) return prev;
              const c = cloneStructure(prev);
              replaceTemplateFileInRoot(c, oldFile, res.file);
              void invoke("snipcast_save_user_structure", { root: c }).catch(showError);
              return c;
            });
            setEditingFile(res.file);
          }
          editorSnapshotRef.current = {
            file: res.file,
            title: editorTitle,
            content: editorContent,
          };
        } catch (e) {
          showError(e);
        }
      })();
    }, 600);
    return () => clearTimeout(t);
  }, [editorTitle, editorContent, editingFile, section, showError]);

  const onAddTemplate = async () => {
    if (!userStructure) return;
    try {
      const { file } = await invoke<{ file: string }>("snipcast_create_user_template_file");
      const next = insertAfterSelection(userStructure, selectedPath, { type: "template", file });
      await persistStructure(next);
      const path = (() => {
        if (!selectedPath || selectedPath.length === 0) {
          return [next.items.length - 1];
        }
        const p = [...selectedPath];
        p[p.length - 1] = p[p.length - 1]! + 1;
        return p;
      })();
      await applySelection(path, next);
    } catch (e) {
      showError(e);
    }
  };

  const onAddFolder = async () => {
    if (!userStructure) return;
    try {
      const item: UserStructureItem = {
        type: "folder",
        id: crypto.randomUUID(),
        title: "Новая папка",
        items: [],
      };
      const next = insertAfterSelection(userStructure, selectedPath, item);
      await persistStructure(next);
      const path = (() => {
        if (!selectedPath || selectedPath.length === 0) {
          return [next.items.length - 1];
        }
        const p = [...selectedPath];
        p[p.length - 1] = p[p.length - 1]! + 1;
        return p;
      })();
      setSelectedPath(path);
      setEditingFile(null);
      setEditorTitle("");
      setEditorContent("");
      editorSnapshotRef.current = null;
    } catch (e) {
      showError(e);
    }
  };

  const onAddSeparator = async () => {
    if (!userStructure) return;
    try {
      const item: UserStructureItem = {
        type: "separator",
        id: crypto.randomUUID(),
      };
      const next = insertAfterSelection(userStructure, selectedPath, item);
      await persistStructure(next);
      const path = (() => {
        if (!selectedPath || selectedPath.length === 0) {
          return [next.items.length - 1];
        }
        const p = [...selectedPath];
        p[p.length - 1] = p[p.length - 1]! + 1;
        return p;
      })();
      setSelectedPath(path);
      setEditingFile(null);
      setEditorTitle("");
      setEditorContent("");
      editorSnapshotRef.current = null;
    } catch (e) {
      showError(e);
    }
  };

  const onMove = async (delta: -1 | 1) => {
    if (!userStructure || !selectedPath) return;
    if (delta === 1) {
      const into = moveIntoFolderBelow(userStructure, selectedPath);
      if (into) {
        try {
          await persistStructure(into.root);
          setSelectedPath(into.newPath);
          const node = getNodeAtPath(into.root, into.newPath);
          if (node?.type === "template") {
            await applySelection(into.newPath, into.root);
          } else {
            setEditingFile(null);
            setEditorTitle("");
            setEditorContent("");
            editorSnapshotRef.current = null;
          }
        } catch (e) {
          showError(e);
        }
        return;
      }
    }
    const moved = moveSelected(userStructure, selectedPath, delta);
    if (!moved) return;
    try {
      await persistStructure(moved);
      const idx = selectedPath[selectedPath.length - 1]! + delta;
      const newPath = [...selectedPath.slice(0, -1), idx];
      setSelectedPath(newPath);
    } catch (e) {
      showError(e);
    }
  };

  const onCancelEdit = () => {
    const snap = editorSnapshotRef.current;
    if (!snap) return;
    setEditorTitle(snap.title);
    setEditorContent(snap.content);
  };

  const onDeleteSelected = async () => {
    if (!userStructure || !selectedPath) return;
    const { root, txtToDelete } = removeAtPath(userStructure, selectedPath);
    try {
      for (const f of txtToDelete) {
        await invoke("snipcast_delete_user_template_txt", { file: f });
      }
      await persistStructure(root);
      setSelectedPath(null);
      setEditingFile(null);
      setEditorTitle("");
      setEditorContent("");
      editorSnapshotRef.current = null;
    } catch (e) {
      showError(e);
    }
  };

  const canMoveUp =
    !!selectedPath &&
    selectedPath.length > 0 &&
    selectedPath[selectedPath.length - 1]! > 0;
  const canMoveDown =
    !!userStructure &&
    !!selectedPath &&
    selectedPath.length > 0 &&
    (() => {
      let list = userStructure.items;
      for (let d = 0; d < selectedPath.length - 1; d++) {
        const n = list[selectedPath[d]!];
        if (!n || n.type !== "folder") return false;
        list = n.items;
      }
      const idx = selectedPath[selectedPath.length - 1]!;
      return idx < list.length - 1;
    })();

  const renderUserItems = (
    items: UserStructureItem[],
    basePath: number[],
    depth: number,
  ): ReactNode =>
    items.map((item, i) => {
      const path = [...basePath, i];
      const key =
        item.type === "template"
          ? `t-${item.file}`
          : item.type === "folder"
            ? `f-${item.id}`
            : `s-${item.id}`;
      const active = pathsEqual(selectedPath, path);
      const label =
        item.type === "template"
          ? item.file.replace(/\.txt$/i, "")
          : item.type === "folder"
            ? item.title
            : "— разделитель —";
      return (
        <div key={key} className="settings__tree-node">
          <button
            type="button"
            className={`settings__tree-row${active ? " is-active" : ""}`}
            style={{ paddingLeft: 10 + depth * 18 }}
            onClick={() => void selectPath(path)}
          >
            {item.type === "folder" ? (
              <span className="settings__tree-icon" aria-hidden>
                📁{" "}
              </span>
            ) : null}
            {item.type === "separator" ? (
              <span className="settings__tree-sep-label">{label}</span>
            ) : (
              label
            )}
          </button>
          {item.type === "folder" ? renderUserItems(item.items, path, depth + 1) : null}
        </div>
      );
    });

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
            className={section === "master" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("master")}
          >
            Мастер шаблоны
          </button>
          <button
            type="button"
            className={section === "user" ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection("user")}
          >
            Свои шаблоны
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
        <header className="settings__toolbar">
          <h1 className="settings__title">
            {section === "general" && "Основные"}
            {section === "master" && "Мастер шаблоны"}
            {section === "user" && "Свои шаблоны"}
            {section === "variables" && "Переменные"}
            {section === "update" && "Обновление"}
          </h1>
        </header>

        {errorToast ? <div className="settings__toast settings__toast--error">{errorToast}</div> : null}

        {section === "general" ? (
          <div className="settings__panel">
            <div className="settings__group">
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
              <div className="settings__option settings__option--stack">
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
              <div className="settings__option settings__option--stack settings__option--disabled">
                <span className="settings__option-label">Тема</span>
                <input type="text" disabled placeholder="В разработке..." />
              </div>
              <div className="settings__option settings__option--stack settings__option--disabled">
                <span className="settings__option-label">Язык</span>
                <input type="text" disabled placeholder="В разработке..." />
              </div>
            </div>
            {paths ? (
              <p className="settings__paths">
                Папка данных: <code>{paths.baseDir}</code>
              </p>
            ) : null}
          </div>
        ) : null}

        {section === "master" ? (
          <div className="settings__panel">
            <p className="settings__lead">Заготовленные шаблоны, редактируемые Администратором.</p>
            <div className="settings__option settings__option--stack">
              <span className="settings__option-label">Путь к папке мастер шаблонов</span>
              <div className="settings__path-field">
                <input
                  type="text"
                  value={masterPathInput}
                  onChange={(e) => setMasterPathInput(e.target.value)}
                  placeholder="Пусто..."
                  spellCheck={false}
                  aria-label="Путь к папке мастер-шаблонов"
                />
                <button
                  type="button"
                  className="settings__folder-btn"
                  title="Выбрать папку"
                  onClick={() => void pickMasterFolder()}
                >
                  Обзор…
                </button>
              </div>
            </div>
            {paths ? (
              <p className="settings__paths">
                Сейчас используется: <code>{paths.masterDir}</code>
              </p>
            ) : null}
          </div>
        ) : null}

        {section === "user" ? (
          <div className="settings__panel settings__panel--user-templates">
            <div className="settings__templates-toolbar">
              <button type="button" className="settings__ghost" onClick={() => void onAddTemplate()}>
                Добавить Шаблон
              </button>
              <button type="button" className="settings__ghost" onClick={() => void onAddFolder()}>
                Добавить Подпункт
              </button>
              <button type="button" className="settings__ghost" onClick={() => void onAddSeparator()}>
                Добавить разделитель
              </button>
              <button
                type="button"
                className="settings__ghost"
                disabled={!canMoveUp}
                title="Выше"
                onClick={() => void onMove(-1)}
              >
                ⬆️
              </button>
              <button
                type="button"
                className="settings__ghost"
                disabled={!canMoveDown}
                title="Ниже"
                onClick={() => void onMove(1)}
              >
                ⬇️
              </button>
              <button
                type="button"
                className="settings__ghost"
                disabled={!editingFile}
                onClick={onCancelEdit}
              >
                Отмена
              </button>
              <button
                type="button"
                className="settings__danger settings__danger--compact"
                disabled={!selectedPath}
                onClick={() => void onDeleteSelected()}
              >
                Удалить
              </button>
            </div>
            <div className="settings__templates-split">
              <div className="settings__templates-list">
                <div className="settings__templates-list-inner">
                  {userStructure ? (
                    userStructure.items.length === 0 ? (
                      <p className="settings__templates-empty">Список пуст. Добавьте шаблон.</p>
                    ) : (
                      renderUserItems(userStructure.items, [], 0)
                    )
                  ) : (
                    <p className="settings__templates-empty">Загрузка…</p>
                  )}
                </div>
              </div>
              <div className="settings__templates-editor">
                {editingFile ? (
                  <>
                    <label className="settings__field-label" htmlFor="user-tpl-title">
                      Заголовок (имя файла)
                    </label>
                    <input
                      id="user-tpl-title"
                      type="text"
                      className="settings__templates-title-input"
                      value={editorTitle}
                      onChange={(e) => setEditorTitle(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <label className="settings__field-label" htmlFor="user-tpl-body">
                      Содержимое
                    </label>
                    <textarea
                      id="user-tpl-body"
                      className="settings__templates-body"
                      value={editorContent}
                      onChange={(e) => setEditorContent(e.target.value)}
                      placeholder="Текст шаблона…"
                      spellCheck={false}
                    />
                    <p className="settings__templates-hint">
                      В палитре описание берётся из первой строки содержимого.
                    </p>
                  </>
                ) : (
                  <p className="settings__templates-placeholder">
                    Выберите шаблон в списке слева, чтобы изменить заголовок и текст.
                  </p>
                )}
              </div>
            </div>
            {paths ? (
              <p className="settings__paths">
                Шаблоны: <code>{paths.userDir}</code> · порядок: <code>{paths.userStructurePath}</code>
              </p>
            ) : null}
          </div>
        ) : null}

        {section === "variables" ? (
          <div className="settings__panel">
            <p className="settings__lead">Значения подставляются в шаблоны вместо плейсхолдеров вида {"{user}"}.</p>
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
            <img className="settings__logo" src="/vite.svg" alt="" width={96} height={96} />
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
      </main>
    </div>
  );
}
