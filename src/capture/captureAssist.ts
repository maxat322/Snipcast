import type { Pt } from "./shapes";

export type CaptureCandidate = {
  id: number; parent: number | null; kind: "window" | "element";
  x: number; y: number; width: number; height: number; windowOrder: number; depth: number;
};
export type CaptureGeometry = { x: number; y: number; width: number; height: number };
export type CaptureRect = { x: number; y: number; w: number; h: number };
export type ScreenMonitor = CaptureGeometry & {scale:number};
export type CandidateIndex={windows:CaptureCandidate[];elements:Map<number,CaptureCandidate[]>};
export function indexCandidates(candidates:CaptureCandidate[]):CandidateIndex {
  const windows=candidates.filter(c=>c.kind==="window").sort((a,b)=>a.windowOrder-b.windowOrder);
  const elements=new Map<number,CaptureCandidate[]>();
  for(const c of candidates)if(c.kind==="element"){
    const group=elements.get(c.windowOrder)??[];group.push(c);elements.set(c.windowOrder,group);
  }
  for(const group of elements.values())group.sort((a,b)=>b.depth-a.depth||a.width*a.height-b.width*b.height);
  return {windows,elements};
}
export function monitorRect(monitors:ScreenMonitor[],point:Pt,info:CaptureGeometry,vp:{w:number;h:number}):CaptureRect {
  const sx=info.width/vp.w,sy=info.height/vp.h;
  const x=info.x+point.x*sx,y=info.y+point.y*sy;
  const m=monitors.find(m=>x>=m.x&&y>=m.y&&x<m.x+m.width&&y<m.y+m.height)
    ??monitors.reduce<ScreenMonitor|undefined>((best,m)=>!best||Math.hypot(x-m.x-m.width/2,y-m.y-m.height/2)<Math.hypot(x-best.x-best.width/2,y-best.y-best.height/2)?m:best,undefined);
  return m?{x:(m.x-info.x)/sx,y:(m.y-info.y)/sy,w:m.width/sx,h:m.height/sy}:{x:0,y:0,w:vp.w,h:vp.h};
}

export function mergeCandidates(current: CaptureCandidate[], incoming: CaptureCandidate[]): CaptureCandidate[] {
  return Array.from(new Map([...current, ...incoming].map(candidate => [candidate.id, candidate])).values());
}

export function proposedRect(candidates: CaptureCandidate[] | CandidateIndex, pointer: Pt, mode: "element" | "window",
  info: CaptureGeometry, viewport: { w: number; h: number }): CaptureRect | null {
  const sx = info.width / viewport.w, sy = info.height / viewport.h;
  const x = info.x + pointer.x * sx, y = info.y + pointer.y * sy;
  const contains = (c: CaptureCandidate) => x >= c.x && y >= c.y && x < c.x + c.width && y < c.y + c.height;
  // First choose the visible top-level window; elements from covered windows cannot win.
  const index=Array.isArray(candidates)?indexCandidates(candidates):candidates;
  const win = index.windows.find(contains);
  if (!win) return null;
  const element = mode === "element" ? index.elements.get(win.windowOrder)?.find(contains) : null;
  const c = element ?? win;
  const left = Math.max(info.x, c.x), top = Math.max(info.y, c.y);
  const right = Math.min(info.x + info.width, c.x + c.width), bottom = Math.min(info.y + info.height, c.y + c.height);
  return right > left && bottom > top ? { x: (left-info.x)/sx, y: (top-info.y)/sy, w: (right-left)/sx, h: (bottom-top)/sy } : null;
}

export function formatPixel(r: number, g: number, b: number, format: "hex" | "rgb"): string {
  return format === "hex" ? `#${[r,g,b].map(v => v.toString(16).padStart(2,"0")).join("").toUpperCase()}` : `rgb(${r}, ${g}, ${b})`;
}

export function floatingPosition(pointer: Pt, width: number, height: number, viewport: { w: number; h: number },bounds:CaptureRect={x:0,y:0,...viewport}) {
  const margin = 8, gap = 20;
  const left = pointer.x + gap + width <= bounds.x+bounds.w - margin ? pointer.x + gap : pointer.x - gap - width;
  const top = pointer.y + gap + height <= bounds.y+bounds.h - margin ? pointer.y + gap : pointer.y - gap - height;
  return { left: Math.max(bounds.x+margin, Math.min(left, bounds.x+bounds.w-width-margin)), top: Math.max(bounds.y+margin, Math.min(top, bounds.y+bounds.h-height-margin)) };
}
