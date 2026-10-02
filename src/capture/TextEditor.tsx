import { useEffect, useLayoutEffect, useRef } from "react";
import type { TextTool } from "./useTextTool";
import { layoutText, TEXT_FONT, TEXT_HANDLES, TEXT_LINE_HEIGHT } from "./textLayout";
import type { TextShape } from "./shapes";

export function TextFrame({ shape, tool, editing = false }: { shape: TextShape; tool: TextTool; editing?: boolean }) {
  const { w, h } = layoutText(shape);
  return <div className={`capture__text-selection${editing ? " is-editing" : ""}`}
    data-text-id={shape.id} data-text-mode={shape.textMode}
    style={{ left: editing ? 0 : shape.p1.x, top: editing ? 0 : shape.p1.y, width: w, height: h }}>
    {TEXT_HANDLES.map((handle) => <div key={handle}
      className={`capture__text-handle capture__text-handle--${handle}`}
      data-tsize={handle} title="Изменить границы текста"
      onPointerDown={(e) => tool.beginResize(e, shape, handle)} />)}
  </div>;
}

export function TextEditor({ tool }: { tool: TextTool }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const session = tool.edit;
  const composing = useRef(false);
  const selection = useRef<{ start: number; end: number; direction: "forward" | "backward" | "none" }>({ start: 0, end: 0, direction: "none" });
  const remember = () => {
    const el = input.current;
    if (el) selection.current = { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection };
  };
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !session) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(session.caret, session.caret);
    remember();
    // Focus only when a session opens, never on geometry/property updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.key]);
  useEffect(() => {
    const onWindowBlur = () => {
      if (tool.gestureRef.current) tool.cancel();
      tool.commit();
    };
    const onPropertiesUp = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".capture__opts")) return;
      const el = input.current;
      if (!el) return;
      if (document.activeElement === el) return;
      // Keep a number input usable while typing; restore the caret on Enter/blur.
      if ((e.target as HTMLInputElement).type === "number") return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(selection.current.start, selection.current.end, selection.current.direction);
    };
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pointerup", onPropertiesUp);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pointerup", onPropertiesUp);
    };
  }, [tool.commit, tool.cancel]);
  if (!session) return null;
  const s = session.shape;
  const layout = layoutText(s);
  return <div className="capture__text-edit-wrap" data-edit-key={session.key}
    style={{ left: s.p1.x, top: s.p1.y, width: layout.w, height: layout.h }}>
    <textarea key={session.key} ref={input} className="capture__text-edit"
      aria-label="Текст на скриншоте" defaultValue={session.original?.text ?? ""} rows={1} spellCheck={false}
      wrap={s.textMode === "frame" ? "soft" : "off"}
      style={{ width: layout.w, height: layout.h, color: s.color, fontSize: s.fontSize,
        fontFamily: TEXT_FONT, lineHeight: TEXT_LINE_HEIGHT,
        whiteSpace: s.textMode === "frame" ? "pre-wrap" : "pre" }}
      onPointerDown={(e) => e.stopPropagation()}
      onSelect={remember} onKeyUp={remember} onPointerUp={remember}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onInput={(e) => { tool.update({ text: e.currentTarget.value }); remember(); }}
      onBlur={(e) => {
        remember();
        if (e.relatedTarget instanceof Element && e.relatedTarget.closest(".capture__opts")) return;
        if (tool.gestureRef.current) return;
        tool.commit();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (e.key === "Escape") { e.preventDefault(); tool.cancel(); }
        else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); tool.commit(); }
      }} />
    {s.textMode === "frame" ? <TextFrame shape={s} tool={tool} editing /> : null}
  </div>;
}
