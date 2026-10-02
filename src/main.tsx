import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsApp } from "./SettingsApp";
import { AiAgentApp } from "./aiagent/AiAgentApp";
import { CaptureOverlay } from "./capture/CaptureOverlay";
import { PinWindow } from "./capture/PinWindow";
import { PinMenuWindow } from "./capture/PinMenuWindow";

/**
 * Не вызываем getCurrentWindow() на верхнем уровне: в Tauri 2 это лезет в
 * window.__TAURI_INTERNALS__.metadata — при ранней загрузке или смене API
 * исключение блокирует весь mount (пустое окно палитры).
 *
 * Оверлеи скриншота живут в динамических окнах: "capture-N" (по одному на
 * монитор) и "pin-N" (закреплённые кропы).
 */
function resolveUiKind(): "settings" | "aiagent" | "palette" | "capture" | "pin" | "pinmenu" {
  const q = new URLSearchParams(window.location.search).get("snipcast");
  if (q === "settings") return "settings";
  /* Демо-режим в обычном браузере: ?snipcast=capture / ?snipcast=pin */
  if (q === "capture") return "capture";
  if (q === "pin") return "pin";

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
    if (label === "aiagent") return "aiagent";
    if (label?.startsWith("capture-")) return "capture";
    if (label?.startsWith("pin-")) return "pin";
    if (label === "pinmenu") return "pinmenu";
  } catch {
    /* ignore */
  }

  return "palette";
}

function mount() {
  const root = document.getElementById("root");
  if (!root) return;

  const kind = resolveUiKind();

  if (kind === "capture" || kind === "pin" || kind === "pinmenu") {
    const rootClass = kind === "capture" ? "capture-root" : "pin-root";
    const bodyClass = kind === "capture" ? "capture-body" : "pin-body";
    document.documentElement.classList.add(rootClass);
    document.body.classList.add(bodyClass);
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        {kind === "capture" ? <CaptureOverlay /> : kind === "pinmenu" ? <PinMenuWindow /> : <PinWindow />}
      </React.StrictMode>,
    );
    return;
  }

  if (kind === "aiagent") {
    document.documentElement.classList.add("aiagent-root");
    document.body.classList.add("aiagent-body");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <AiAgentApp />
      </React.StrictMode>,
    );
    return;
  }

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
