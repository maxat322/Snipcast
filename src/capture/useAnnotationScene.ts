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
  const scale=useCallback((sx:number,sy:number)=>{
    if(sx===1&&sy===1)return;
    const convert=(items:Shape[])=>items.map(s=>{
      const p1={x:s.p1.x*sx,y:s.p1.y*sy},p2={x:s.p2.x*sx,y:s.p2.y*sy};
      return s.kind==="text"?{...s,p1,p2,width:s.width*sx,minHeight:s.minHeight*sy,fontSize:s.fontSize*sx,outlineWidth:(s.outlineWidth??0)*sx}:
        {...s,p1,p2,thickness:s.thickness*sx,points:s.points?.map(p=>({x:p.x*sx,y:p.y*sy}))};
    });
    past.current=past.current.map(convert);future.current=future.current.map(convert);
    if(transaction.current)transaction.current=convert(transaction.current);setShapes(convert(ref.current));
  },[setShapes]);
  const translate=useCallback((dx:number,dy:number)=>{
    if(!dx&&!dy)return;
    const convert=(items:Shape[])=>items.map(s=>({...s,p1:{x:s.p1.x+dx,y:s.p1.y+dy},p2:{x:s.p2.x+dx,y:s.p2.y+dy},
      ...(s.kind==="freehand"?{points:s.points?.map(p=>({x:p.x+dx,y:p.y+dy}))}:{})}));
    past.current=past.current.map(convert);future.current=future.current.map(convert);
    if(transaction.current)transaction.current=convert(transaction.current);setShapes(convert(ref.current));
  },[setShapes]);
  const snapshot=()=>{finish();return {shapes:ref.current,past:past.current,future:future.current};};
  const restore=(value:ReturnType<typeof snapshot>)=>{transaction.current=null;past.current=value.past;future.current=value.future;setShapes(value.shapes);};
  return { shapes, ref, setShapes, begin, finish, cancel, change, undo, reset,scale,translate,snapshot,restore };
}
export type AnnotationScene = ReturnType<typeof useAnnotationScene>;
