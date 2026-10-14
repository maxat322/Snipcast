import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsApp } from "./SettingsApp";
import { AiAgentApp } from "./aiagent/AiAgentApp";
import { CaptureOverlay } from "./capture/CaptureOverlay";
import { PinWindow } from "./capture/PinWindow";
import { PinMenuWindow } from "./capture/PinMenuWindow";
import {UpdateNotice} from "./UpdateNotice";
import {TextSuggestions} from "./suggestions/TextSuggestions";
import {RecordControl,VideoEditor} from "./video/VideoApp";
import "./paletteSurface.css";

/**
 * Не вызываем getCurrentWindow() на верхнем уровне: в Tauri 2 это лезет в
 * window.__TAURI_INTERNALS__.metadata — при ранней загрузке или смене API
 * исключение блокирует весь mount (пустое окно палитры).
 *
 * Скриншот живёт в едином окне "capture-0" на виртуальном рабочем столе,
 * закреплённые кропы — в окнах "pin-N".
 */
function resolveUiKind(): "settings" | "aiagent" | "palette" | "capture" | "pin" | "pinmenu" | "update-notice" | "video-control" | "video-editor" | "text-suggestions" {
  const q = new URLSearchParams(window.location.search).get("snipcast");
  if (q === "settings") return "settings";
  if(q==="text-suggestions")return q;
  if(q==="video-control"||q==="video-editor")return q;
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
    if(label==="update-notice")return "update-notice";
  } catch {
    /* ignore */
  }

  return "palette";
}

function mount() {
  const root = document.getElementById("root");
  if (!root) return;

  const kind = resolveUiKind();
  if(kind==="text-suggestions") { document.documentElement.classList.add("suggestions-root");ReactDOM.createRoot(root).render(<TextSuggestions/>);return; }
  if(kind==="video-control"||kind==="video-editor"){
    document.documentElement.classList.add("video-root");
    ReactDOM.createRoot(root).render(kind==="video-control"?<RecordControl/>:<VideoEditor/>);return;
  }
  if(kind==="update-notice"){
    document.documentElement.classList.add("update-root");
    ReactDOM.createRoot(root).render(<UpdateNotice/>);return;
  }

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
    document.documentElement.classList.add("palette-root");
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
