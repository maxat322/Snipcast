/** Физический код клавиши → токен для строки global-hotkey / Tauri (как в parse_key). */
function codeToMainKey(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);

  const map: Record<string, string> = {
    Backquote: "Backquote",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Backspace: "Backspace",
    Tab: "Tab",
    Enter: "Enter",
    Space: "Space",
    Escape: "Escape",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    CapsLock: "CapsLock",
    ScrollLock: "ScrollLock",
    Pause: "Pause",
    PrintScreen: "PrintScreen",
    ContextMenu: "ContextMenu",
  };

  if (map[code]) return map[code];

  const fn = /^F(\d{1,2})$/.exec(code);
  if (fn) return `F${fn[1]}`;

  if (code.startsWith("Numpad")) {
    const n = code.slice(6);
    if (n === "Decimal") return "NumpadDecimal";
    if (n === "Add") return "NumpadAdd";
    if (n === "Subtract") return "NumpadSubtract";
    if (n === "Multiply") return "NumpadMultiply";
    if (n === "Divide") return "NumpadDivide";
    if (n === "Enter") return "NumpadEnter";
    if (n === "Equal") return "NumpadEqual";
    if (/^\d$/.test(n)) return `Numpad${n}`;
  }

  return null;
}

const MODIFIER_ONLY_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/**
 * Собирает строку вида CommandOrControl+Shift+Backslash для Rust.
 * Использует e.code (физическая клавиша), поэтому работает на русской раскладке.
 */
export function keyboardEventToTauriHotkey(e: KeyboardEvent): string | null {
  if (e.repeat) return null;
  if (MODIFIER_ONLY_CODES.has(e.code)) return null;

  const main = codeToMainKey(e.code);
  if (!main) return null;

  const parts: string[] = [];
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
  parts.push(main);

  return parts.join("+");
}

/** Отображение в поле настроек: Ctrl+Shift+\ и т.п. */
export function tauriHotkeyToDisplay(tauri: string): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const raw = tauri.trim();
  if (!raw) return "";

  const segments = raw.split("+").map((s) => s.trim());
  const out: string[] = [];

  for (const seg of segments) {
    const u = seg.toLowerCase();
    if (u === "commandorcontrol") {
      out.push(isMac ? "⌘" : "Ctrl");
      continue;
    }
    if (u === "shift") {
      out.push("Shift");
      continue;
    }
    if (u === "alt") {
      out.push("Alt");
      continue;
    }
    if (u === "control" || u === "ctrl") {
      out.push("Ctrl");
      continue;
    }
    if (u === "super" || u === "command" || u === "cmd") {
      out.push("⌘");
      continue;
    }
    if (u === "backslash" || u === "\\") {
      out.push("\\");
      continue;
    }
    if (u === "space") {
      out.push("Space");
      continue;
    }
    if (u.length === 1) {
      out.push(seg.toUpperCase());
      continue;
    }
    out.push(seg);
  }

  return out.join("+");
}
