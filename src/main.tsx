import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { SettingsApp } from "./SettingsApp";

const label = getCurrentWindow().label;
const root = document.getElementById("root") as HTMLElement;

if (label === "settings") {
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
