import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/hotkeyFormat.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { createHotkeyRecorder } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

function event(type, overrides = {}) {
  return {
    type, code: "", key: "PrintScreen", keyCode: 44,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
    ...overrides,
  };
}

test("Windows keyup-only PrintScreen is recorded with an empty code", () => {
  const recorder = createHotkeyRecorder();
  assert.equal(recorder.record(event("keyup")), "PrintScreen");
  assert.equal(recorder.record(event("keyup", { ctrlKey: true, shiftKey: true })),
    "Shift+CommandOrControl+PrintScreen");
  assert.equal(recorder.record(event("keyup", { altKey: true })), "Alt+PrintScreen");
});

test("PrintScreen identity falls back to key or legacy VK_SNAPSHOT", () => {
  for (const identity of [
    { code: "PrintScreen", key: "Unidentified", keyCode: 0 },
    { key: "PrintScreen", keyCode: 0 },
    { key: "Unidentified", keyCode: 44 },
  ]) {
    assert.equal(createHotkeyRecorder().record(event("keyup", identity)), "PrintScreen");
  }
});

test("a down/up pair saves once and preserves modifiers from keydown", () => {
  const recorder = createHotkeyRecorder();
  assert.equal(recorder.record(event("keydown", { ctrlKey: true })),
    "CommandOrControl+PrintScreen");
  assert.equal(recorder.record(event("keydown", { ctrlKey: true, repeat: true })), null);
  assert.equal(recorder.record(event("keyup")), null);
  assert.equal(recorder.record(event("keyup")), "PrintScreen");
});

test("focus reset does not discard the next keyup-only recording", () => {
  const recorder = createHotkeyRecorder();
  recorder.record(event("keydown"));
  recorder.reset();
  assert.equal(recorder.record(event("keyup")), "PrintScreen");
});

test("normal keys still use physical codes and never save on keyup", () => {
  const recorder = createHotkeyRecorder();
  const key = { code: "KeyA", key: "ф", keyCode: 65, ctrlKey: true };
  assert.equal(recorder.record(event("keydown", key)), "CommandOrControl+A");
  assert.equal(recorder.record(event("keyup", key)), null);
  assert.equal(recorder.record(event("keydown", { code: "ControlLeft", key: "Control", keyCode: 17 })), null);
  assert.equal(recorder.record(event("keyup", { code: "ControlLeft", key: "Control", keyCode: 17 })), null);
});
