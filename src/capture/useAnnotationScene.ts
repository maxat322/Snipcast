import { useCallback, useRef, useState, type SetStateAction } from "react";
import type { Shape } from "./shapes";

/** Synchronous snapshots make export and history independent of React batching. */
export function useAnnotationScene() {
  const [shapes, render] = useState<Shape[]>([]);
  const ref = useRef<Shape[]>([]);
  const past = useRef<Shape[][]>([]);
  const future = useRef<Shape[][]>([]);
  const transaction = useRef<Shape[] | null>(null);
  const setShapes = useCallback((action: SetStateAction<Shape[]>) => {
    ref.current = typeof action === "function" ? action(ref.current) : action;
    render(ref.current);
  }, []);
  const begin = useCallback(() => { transaction.current ??= ref.current; }, []);
  const finish = useCallback(() => {
    const before = transaction.current;
    transaction.current = null;
    if (before && JSON.stringify(before) !== JSON.stringify(ref.current)) {
      past.current.push(before);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
    }
  }, []);
  const cancel = useCallback(() => {
    if (transaction.current) setShapes(transaction.current);
    transaction.current = null;
  }, [setShapes]);
  const change = useCallback((action: SetStateAction<Shape[]>) => {
    const ownsTransaction = transaction.current === null;
    if (ownsTransaction) begin();
    setShapes(action);
    if (ownsTransaction) finish();
  }, [begin, setShapes, finish]);
  const undo = useCallback((redo = false) => {
    finish();
    const from = redo ? future.current : past.current;
    const to = redo ? past.current : future.current;
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push(ref.current);
    setShapes(snapshot);
  }, [finish, setShapes]);
  const reset = useCallback(() => {
    transaction.current = null; past.current = []; future.current = []; setShapes([]);
  }, [setShapes]);
  return { shapes, ref, setShapes, begin, finish, cancel, change, undo, reset };
}
export type AnnotationScene = ReturnType<typeof useAnnotationScene>;
