import type { PaletteListDensity, UiThemeSetting } from "./types";

export function normalizeUiTheme(v: string | undefined | null): UiThemeSetting {
  if (v === "light" || v === "dark" || v === "system") return v;
  return "dark";
}

export function normalizePaletteListDensity(v: string | undefined | null): PaletteListDensity {
  if (v === "compact" || v === "normal") return v;
  return "normal";
}

export function resolveUiTheme(setting: UiThemeSetting): "light" | "dark" {
  if (setting === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return setting;
}

/** Устанавливает `data-app-theme` на `<html>`: `light` или `dark` (для system — по ОС). */
export function applyUiThemeSetting(setting: UiThemeSetting): void {
  document.documentElement.setAttribute("data-app-theme", resolveUiTheme(setting));
}

export function applyPaletteListDensity(density: PaletteListDensity): void {
  document.documentElement.setAttribute("data-palette-density", density);
}
