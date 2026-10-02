/** Демо-режим вне Tauri (обычный браузер): invoke-команды заменяются заглушками. */
export function isDemoMode(): boolean {
  return (
    typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === "undefined"
  );
}
