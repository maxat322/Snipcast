/**
 * Векторные аннотации для скриншота: модель, отрисовка на Canvas2D и хит-тесты.
 * Все координаты фигур — в CSS-пикселях окна; физический масштаб `k`
 * (≈ devicePixelRatio) применяется только при отрисовке.
 */

export type ShapeKind = "line" | "rect" | "square" | "ellipse" | "circle" | "arrow" | "text";
export type Pt = { x: number; y: number };
type ShapeBase = { id: number; color: string; p1: Pt; p2: Pt };
export type DrawShape = ShapeBase & { kind: Exclude<ShapeKind, "text">; thickness: number };
export type TextShape = ShapeBase & {
  kind: "text";
  /** Original text, including hard line breaks; soft breaks belong to layout. */
  text: string;
  /** p1 is the top-left corner in CSS pixels, not a baseline. */
  fontSize: number;
  textMode: "auto" | "frame";
  width: number;
  minHeight: number;
};
export type Shape = DrawShape | TextShape;
export type Bounds = { x: number; y: number; w: number; h: number };

import { drawText, textBounds } from "./textLayout";
export { textBounds } from "./textLayout";

export function shapeBounds(s: Shape): Bounds {
  if (s.kind === "text") return textBounds(s);
  const x = Math.min(s.p1.x, s.p2.x);
  const y = Math.min(s.p1.y, s.p2.y);
  return { x, y, w: Math.abs(s.p2.x - s.p1.x), h: Math.abs(s.p2.y - s.p1.y) };
}

/** Длина «наконечника» стрелки: ~4×толщины, но в разумных пределах. */
function arrowHeadLen(thickness: number): number {
  return Math.min(28, Math.max(10, thickness * 4));
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Рисует одну фигуру на контексте. `k` — физический масштаб: все CSS-координаты
 * и размеры умножаются на него (k=1, если контекст уже отмасштабирован).
 */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape, k: number): void {
  const x1 = s.p1.x * k;
  const y1 = s.p1.y * k;
  const x2 = s.p2.x * k;
  const y2 = s.p2.y * k;

  if (s.kind === "text") {
    drawText(ctx, s, k);
    return;
  }
  const th = Math.max(1, s.thickness) * k;

  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = th;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (s.kind === "line") {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  } else if (s.kind === "rect" || s.kind === "square") {
    const rx = Math.min(x1, x2);
    const ry = Math.min(y1, y2);
    ctx.strokeRect(rx, ry, Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (s.kind === "ellipse" || s.kind === "circle") {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.kind === "arrow") {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const hl = arrowHeadLen(s.thickness) * k;
    const wing = hl * 0.45;
    // Конец линии — основание наконечника, чтобы ствол не выходил за кончик.
    const bx = x2 - Math.cos(ang) * hl;
    const by = y2 - Math.sin(ang) * hl;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(bx + Math.sin(ang) * wing, by - Math.cos(ang) * wing);
    ctx.lineTo(bx - Math.sin(ang) * wing, by + Math.cos(ang) * wing);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Попадание точки (CSS px) в фигуру: линия/стрелка — рядом с отрезком или
 * наконечником; прямоугольник — по рамке; текст — по прямоугольнику текста.
 */
export function hitTest(s: Shape, pt: Pt): boolean {

  if (s.kind === "text") {
    const b = textBounds(s);
    return pt.x >= b.x - 4 && pt.x <= b.x + b.w + 4 && pt.y >= b.y - 4 && pt.y <= b.y + b.h + 4;
  }

  const tol = s.thickness / 2 + 5;
  if (s.kind === "rect" || s.kind === "square") {
    const x = Math.min(s.p1.x, s.p2.x);
    const y = Math.min(s.p1.y, s.p2.y);
    const w = Math.abs(s.p2.x - s.p1.x);
    const h = Math.abs(s.p2.y - s.p1.y);
    const nearL = Math.abs(pt.x - x) <= 6;
    const nearR = Math.abs(pt.x - (x + w)) <= 6;
    const nearT = Math.abs(pt.y - y) <= 6;
    const nearB = Math.abs(pt.y - (y + h)) <= 6;
    const withinX = pt.x >= x - 6 && pt.x <= x + w + 6;
    const withinY = pt.y >= y - 6 && pt.y <= y + h + 6;
    return ((nearL || nearR) && withinY) || ((nearT || nearB) && withinX);
  }

  if (s.kind === "ellipse" || s.kind === "circle") {
    const cx = (s.p1.x + s.p2.x) / 2;
    const cy = (s.p1.y + s.p2.y) / 2;
    const rx = Math.abs(s.p2.x - s.p1.x) / 2;
    const ry = Math.abs(s.p2.y - s.p1.y) / 2;
    if (rx < 2 || ry < 2) {
      return Math.hypot(pt.x - cx, pt.y - cy) <= tol;
    }
    // Близость к линии эллипса по нормированному радиусу.
    const nr = Math.hypot((pt.x - cx) / rx, (pt.y - cy) / ry);
    return Math.abs(nr - 1) * Math.min(rx, ry) <= Math.max(6, tol);
  }

  const onShaft = distToSegment(pt.x, pt.y, s.p1.x, s.p1.y, s.p2.x, s.p2.y) <= tol;
  if (onShaft) return true;
  if (s.kind === "arrow") {
    return Math.hypot(pt.x - s.p2.x, pt.y - s.p2.y) <= arrowHeadLen(s.thickness) + 4;
  }
  return false;
}
