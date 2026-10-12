import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "../capture.css";

/**
 * Отдельное окно контекстного меню закрепа (`pinmenu`): маленькое,
 * always-on-top, живёт вне окна закрепа — не обрезается его краями.
 * Клик мимо (потеря фокуса) и Esc закрывают окно на стороне Rust/клавиатуры.
 */
export type PinMenuAction = "copy" | "annotate" | "close" | "close_all";
function MenuIcon({ action }: { action: PinMenuAction }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {action==="copy"?<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>
    :action==="annotate"?<><path d="m15 4 5 5M4 15 15 4a3.5 3.5 0 0 1 5 5L9 20l-6 1 1-6Z"/><path d="m4 15 5 5"/></>
    :action==="close"?<path d="m6 6 12 12M18 6 6 18"/>
    :<><rect x="7" y="7" width="14" height="14" rx="2"/><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2m4-6 6 6m0-6-6 6"/></>}
  </svg>;
}
export function PinMenuWindow({ onAction, onDismiss }: { onAction?: (action: PinMenuAction) => void; onDismiss?: () => void } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (onDismiss) onDismiss(); else void getCurrentWindow().close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDismiss]);

  const run = (action: PinMenuAction) => {
    if (onAction) { onAction(action); return; }
    if (busy) return;
    setBusy(true); setError("");
    void invoke("snipcast_pin_menu_action", { action }).catch(() =>
      setError("Не удалось выполнить действие"),
    ).finally(() => setBusy(false));
  };

  return (
    <div className="pinmenu">
      <button type="button" disabled={busy} className="pinmenu__item" onClick={() => run("copy")}>
        <MenuIcon action="copy" /><span>Копировать</span>
      </button>
      <button type="button" disabled={busy} className="pinmenu__item" onClick={() => run("annotate")}>
        <MenuIcon action="annotate" /><span>Аннотировать</span>
      </button>
      <button type="button" disabled={busy} className="pinmenu__item" onClick={() => run("close")}>
        <MenuIcon action="close" /><span>Закрыть</span>
      </button>
      <button type="button" disabled={busy} className="pinmenu__item" onClick={() => run("close_all")}>
        <MenuIcon action="close_all" /><span>Закрыть все закрепы</span>
      </button>
      {error ? <div className="pinmenu__error" role="alert">{error}</div> : null}
    </div>
  );
}
