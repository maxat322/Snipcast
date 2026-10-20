import type { Pt, Shape } from "./shapes";

/** Convert scene coordinates without changing the original objects or undo stack. */
export function transformAnnotations(shapes: Shape[], scale: number, offset: Pt, physicalSnapshot = false): Shape[] {
  // Only quantize the persisted snapshot. Rounding the display coordinates as
  // well would accumulate error and defeat deduplication after a scale change.
  const n = (value: number) => physicalSnapshot ? Math.round(value * 1e6) / 1e6 : value;
  const point = (p: Pt): Pt => ({ x: n(p.x * scale + offset.x), y: n(p.y * scale + offset.y) });
  return shapes.map(s => s.kind === "text"
    ? { ...s, p1: point(s.p1), p2: point(s.p2), width: n(s.width * scale),
        minHeight: n(s.minHeight * scale), fontSize: n(s.fontSize * scale),
        outlineWidth: s.outlineWidth == null ? undefined : n(s.outlineWidth * scale) }
    : { ...s, p1: point(s.p1), p2: point(s.p2), thickness: n(s.thickness * scale),
        points: s.points?.map(point) });
}
