import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "../capture.css";

/**
 * Отдельное окно контекстного меню закрепа (`pinmenu`): маленькое,
 * always-on-top, живёт вне окна закрепа — не обрезается его краями.
 * Клик мимо (потеря фокуса) и Esc закрывают окно на стороне Rust/клавиатуры.
 */
export function PinMenuWindow() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void getCurrentWindow().close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const run = (action: "close" | "close_all") => {
    void invoke("snipcast_pin_menu_action", { action }).catch((e) =>
      console.error("[Snipcast] menu action:", e),
    );
  };

  return (
    <div className="pinmenu">
      <button type="button" className="pinmenu__item" onClick={() => run("close")}>
        Закрыть
      </button>
      <button type="button" className="pinmenu__item" onClick={() => run("close_all")}>
        Закрыть все закрепы
      </button>
    </div>
  );
}
