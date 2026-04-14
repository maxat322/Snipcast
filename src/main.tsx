import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsApp } from "./SettingsApp";

/**
 * Не вызываем getCurrentWindow() на верхнем уровне: в Tauri 2 это лезет в
 * window.__TAURI_INTERNALS__.metadata — при ранней загрузке или смене API
 * исключение блокирует весь mount (пустое окно палитры).
 */
function resolveUiKind(): "settings" | "palette" {
  const q = new URLSearchParams(window.location.search).get("snipcast");
  if (q === "settings") return "settings";

  try {
    const w = window as Window & {
      __TAURI_INTERNALS__?: {
        metadata?: {
          currentWindow?: { label?: string };
          currentWebview?: { windowLabel?: string };
        };
      };
    };
    const meta = w.__TAURI_INTERNALS__?.metadata;
    const label = meta?.currentWindow?.label ?? meta?.currentWebview?.windowLabel;
    if (label === "settings") return "settings";
  } catch {
    /* ignore */
  }

  return "palette";
}

function mount() {
  const root = document.getElementById("root");
  if (!root) return;

  const kind = resolveUiKind();

  if (kind === "settings") {
    document.documentElement.classList.add("settings-root");
    document.body.classList.add("settings-body");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <SettingsApp />
      </React.StrictMode>,
    );
  } else {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}

/* Дать рантайму Tauri шанс проставить __TAURI_INTERNALS__ до чтения метаданных */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => queueMicrotask(mount));
} else {
  queueMicrotask(mount);
}
