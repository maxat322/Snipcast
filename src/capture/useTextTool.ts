import { useCallback, useRef, useState } from "react";
import type { AnnotationScene } from "./useAnnotationScene";
import type { Pt, TextShape } from "./shapes";
import { caretAtPoint, layoutText, resizeText, type TextHandle } from "./textLayout";

// Native textarea + explicit, idempotent submission/property-focus lifecycle:
// adapted from Excalidraw textWysiwyg, ed10ac7dca7e40f3f4a31269b4bfba980d0db41e.
// See THIRD_PARTY.md and licenses/excalidraw-MIT.txt. Scene/gesture code is Snipcast's.
export type TextSession = { key: number; shape: TextShape; original: TextShape | null; caret: number };
type Gesture = {
  pointerId: number; owner: HTMLElement; start: Pt; latest: Pt; moved: boolean;
} & (
  | { mode: "create"; seed: TextShape }
  | { mode: "move"; original: TextShape }
  | { mode: "resize"; original: TextShape; handle: TextHandle; editing: boolean }
);
type Options = { scene: AnnotationScene; select: (id: number | null) => void;
  leaveTool: () => void; nextId: () => number; color: string; fontSize: number };
const point = (e: { clientX: number; clientY: number }): Pt => ({ x: e.clientX, y: e.clientY });

export function useTextTool(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [edit, renderEdit] = useState<TextSession | null>(null);
  const editRef = useRef<TextSession | null>(null);
  const [frame, setFrame] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const seq = useRef(0);
  const setEdit = useCallback((session: TextSession | null) => {
    editRef.current = session; renderEdit(session);
  }, []);
  const update = useCallback((patch: Partial<TextShape>) => {
    const session = editRef.current;
    if (session) setEdit({ ...session, shape: { ...session.shape, ...patch } });
  }, [setEdit]);
  const open = useCallback((shape: TextShape, pt?: Pt, isNew = false) => {
    setEdit({ key: ++seq.current, shape, original: isNew ? null : shape,
      caret: pt ? caretAtPoint(shape, pt) : shape.text.length });
    optionsRef.current.select(shape.id);
  }, [setEdit]);
  const commit = useCallback(() => {
    const session = editRef.current;
    if (!session) return optionsRef.current.scene.ref.current;
    // Clear the synchronous guard before blur/unmount/exports can submit again.
    setEdit(null);
    const { scene, select, leaveTool } = optionsRef.current;
    const shape = session.shape;
    scene.change((shapes) => {
      if (!shape.text.trim()) return shapes.filter((s) => s.id !== shape.id);
      return session.original ? shapes.map((s) => s.id === shape.id ? shape : s) : [...shapes, shape];
    });
    select(shape.text.trim() ? shape.id : null);
    leaveTool();
    return scene.ref.current;
  }, [setEdit]);
  const release = useCallback(() => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (g?.owner.hasPointerCapture(g.pointerId)) g.owner.releasePointerCapture(g.pointerId);
  }, []);
  const cancel = useCallback(() => {
    const g = gestureRef.current;
    if (g) {
      if (g.mode === "resize" && g.editing) update(g.original);
      else if (g.mode !== "create") optionsRef.current.scene.cancel();
      release(); setFrame(null);
      return true;
    }
    const session = editRef.current;
    if (!session) return false;
    setEdit(null);
    optionsRef.current.select(session.original?.id ?? null);
    optionsRef.current.leaveTool();
    return true;
  }, [setEdit, release, update]);
  const capture = useCallback((gesture: Gesture) => {
    gestureRef.current = gesture;
    gesture.owner.setPointerCapture(gesture.pointerId);
  }, []);
  const beginCreate = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const { nextId, color, fontSize, select } = optionsRef.current;
    const p1 = point(e);
    const seed: TextShape = { id: nextId(), kind: "text", color, fontSize, p1, p2: p1,
      text: "", textMode: "auto", width: 0, minHeight: 0 };
    select(null);
    capture({ mode: "create", seed, start: p1, latest: p1, moved: false,
      pointerId: e.pointerId, owner: e.currentTarget });
  }, [capture]);
  const beginMove = useCallback((e: React.PointerEvent<HTMLElement>, original: TextShape) => {
    optionsRef.current.select(original.id);
    optionsRef.current.scene.begin();
    capture({ mode: "move", original, start: point(e), latest: point(e), moved: false,
      pointerId: e.pointerId, owner: e.currentTarget });
  }, [capture]);
  const beginResize = useCallback((e: React.PointerEvent<HTMLElement>, original: TextShape, handle: TextHandle) => {
    e.preventDefault(); e.stopPropagation();
    const editing = !!editRef.current;
    if (!editing) optionsRef.current.scene.begin();
    capture({ mode: "resize", original, handle, editing, start: point(e), latest: point(e), moved: false,
      pointerId: e.pointerId, owner: e.currentTarget });
  }, [capture]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    g.latest = point(e);
    g.moved ||= Math.hypot(g.latest.x - g.start.x, g.latest.y - g.start.y) >= 4;
    if (!g.moved) return;
    if (g.mode === "create") {
      setFrame({ x: Math.min(g.start.x, g.latest.x), y: Math.min(g.start.y, g.latest.y),
        w: Math.abs(g.latest.x - g.start.x), h: Math.abs(g.latest.y - g.start.y) });
      return;
    }
    const p1 = { x: g.original.p1.x + g.latest.x - g.start.x, y: g.original.p1.y + g.latest.y - g.start.y };
    const next = g.mode === "move" ? { ...g.original, p1, p2: p1 }
      : resizeText(g.original, g.handle, g.start, g.latest);
    if (g.mode === "resize" && g.editing) update(next);
    else optionsRef.current.scene.setShapes((shapes) => shapes.map((s) => s.id === next.id ? next : s));
  }, [update]);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    onPointerMove(e);
    release(); setFrame(null);
    if (g.mode === "create") {
      const p1 = g.moved ? { x: Math.min(g.start.x, g.latest.x), y: Math.min(g.start.y, g.latest.y) } : g.start;
      const shape: TextShape = { ...g.seed, p1, p2: p1,
        textMode: g.moved ? "frame" : "auto",
        width: g.moved ? Math.max(8, Math.abs(g.latest.x - g.start.x)) : 0,
        minHeight: g.moved ? Math.abs(g.latest.y - g.start.y) : 0 };
      layoutText(shape);
      open(shape, undefined, true);
    } else if (!(g.mode === "resize" && g.editing)) optionsRef.current.scene.finish();
  }, [onPointerMove, release, open]);
  const reset = useCallback(() => { release(); setFrame(null); setEdit(null); }, [release, setEdit]);
  return { edit, editRef, frame, gestureRef, update, open, commit, cancel, reset,
    beginCreate, beginMove, beginResize, onPointerMove, onPointerUp };
}
export type TextTool = ReturnType<typeof useTextTool>;
