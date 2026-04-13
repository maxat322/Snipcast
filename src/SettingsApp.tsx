import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { keyboardEventToTauriHotkey, tauriHotkeyToDisplay } from "./hotkeyFormat";
import type { AppConfig, PathsDto, UserTemplateFile } from "./types";
import "./Settings.css";

const REPO_URL = "https://github.com/maxat32/Snipcast";

type Section = "general" | "master" | "user" | "variables" | "update";

const DEFAULT_NEW_TEMPLATE = `{
  "id": "my-template",
  "title": "Новый шаблон",
  "preview": "Краткое описание",
  "pasteText": "Текст для вставки с {user}"
}
`;

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
  const [userFiles, setUserFiles] = useState<UserTemplateFile[]>([]);
  const [selectedUserFile, setSelectedUserFile] = useState<string | null>(null);
  const [userEditor, setUserEditor] = useState("");
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
      const [p, c, v, uf, vars] = await Promise.all([
        invoke<PathsDto>("snipcast_get_paths"),
        invoke<AppConfig>("snipcast_get_config"),
        invoke<string>("snipcast_get_version"),
        invoke<UserTemplateFile[]>("snipcast_list_user_templates"),
        invoke<Record<string, unknown>>("snipcast_get_variables"),
      ]);
      setPaths(p);
      setConfig(c);
      setHotkeyDisplay(tauriHotkeyToDisplay(c.paletteHotkey));
      setMasterPathInput(c.masterTemplatesPath ?? "");
      setVersion(v);
      setUserFiles(uf);
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

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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

  useEffect(() => {
    if (!selectedUserFile) return;
    const t = window.setTimeout(() => {
      void invoke("snipcast_write_user_template", {
        name: selectedUserFile,
        content: userEditor,
      })
        .then(() =>
          invoke<UserTemplateFile[]>("snipcast_list_user_templates").then(setUserFiles),
        )
        .catch(showError);
    }, 600);
    return () => clearTimeout(t);
  }, [userEditor, selectedUserFile, showError]);

  const onNewUserFile = () => {
    const name = `template-${Date.now()}.json`;
    setSelectedUserFile(name);
    setUserEditor(DEFAULT_NEW_TEMPLATE);
  };

  const onDeleteUserFile = async () => {
    if (!selectedUserFile) return;
    try {
      await invoke("snipcast_delete_user_template", { name: selectedUserFile });
      setSelectedUserFile(null);
      setUserEditor("");
      const uf = await invoke<UserTemplateFile[]>("snipcast_list_user_templates");
      setUserFiles(uf);
    } catch (e) {
      showError(e);
    }
  };

  const onSelectUserFile = (f: UserTemplateFile) => {
    setSelectedUserFile(f.name);
    setUserEditor(f.content);
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
          <div className="settings__panel settings__panel--split">
            <div className="settings__filelist">
              <div className="settings__filelist-head">
                <span>Файлы в {paths?.userDir ?? "…"}</span>
                <button type="button" className="settings__ghost" onClick={onNewUserFile}>
                  + Новый
                </button>
              </div>
              <ul>
                {userFiles.map((f) => (
                  <li key={f.name}>
                    <button
                      type="button"
                      className={selectedUserFile === f.name ? "is-active" : ""}
                      onClick={() => onSelectUserFile(f)}
                    >
                      {f.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="settings__editor">
              <textarea
                value={userEditor}
                onChange={(e) => setUserEditor(e.target.value)}
                placeholder="Выберите файл или создайте новый"
                spellCheck={false}
              />
              <div className="settings__editor-actions">
                <button
                  type="button"
                  className="settings__danger"
                  disabled={!selectedUserFile}
                  onClick={() => void onDeleteUserFile()}
                >
                  Удалить файл
                </button>
              </div>
            </div>
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
