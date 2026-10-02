import type { Bounds, Pt, TextShape } from "./shapes";

export const TEXT_FONT = "Inter, system-ui, sans-serif";
export const TEXT_LINE_HEIGHT = 1.2;
export const TEXT_MIN_WIDTH = 8;
export const TEXT_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type TextHandle = (typeof TEXT_HANDLES)[number];
export type TextLine = { text: string; start: number; end: number; runs: { text: string; x: number }[] };
export type TextLayout = { w: number; h: number; contentHeight: number; lineHeight: number; baseline: number; lines: TextLine[] };

let mirror: HTMLDivElement | null = null;
let context: CanvasRenderingContext2D | null = null;
const cache = new Map<string, TextLayout>();

/** Let the same browser that edits the textarea determine Unicode soft breaks.
 * Unlike a second word-wrapper, native Range measurements also preserve tabs,
 * hanging spaces, emoji sequences and explicit empty/trailing lines.
 * Cached layouts are in CSS pixels; DPR is applied only by the renderer.
 */
export function layoutText(s: TextShape): TextLayout {
  const key = JSON.stringify([s.text, s.fontSize, s.textMode, s.width, s.minHeight]);
  const cached = cache.get(key);
  if (cached) return cached;
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    Object.assign(mirror.style, {
      position: "fixed", left: "0", top: "0", visibility: "hidden", pointerEvents: "none",
      display: "inline-block", margin: "0", padding: "0", border: "0", boxSizing: "content-box",
      fontFamily: TEXT_FONT, fontWeight: "400", fontStyle: "normal", letterSpacing: "normal",
      overflowWrap: "break-word", wordBreak: "normal", tabSize: "4", direction: "ltr",
      fontKerning: "auto",
    });
    document.body.append(mirror);
    context = document.createElement("canvas").getContext("2d");
  }
  const lineHeight = s.fontSize * TEXT_LINE_HEIGHT;
  Object.assign(mirror.style, {
    fontSize: `${s.fontSize}px`, lineHeight: `${lineHeight}px`,
    width: s.textMode === "frame" ? `${Math.max(TEXT_MIN_WIDTH, s.width)}px` : "max-content",
    whiteSpace: s.textMode === "frame" ? "pre-wrap" : "pre",
  });
  // The zero-width sentinel gives empty and trailing lines their actual height.
  const node = document.createTextNode(s.text + "\u200b");
  mirror.replaceChildren(node);
  const box = mirror.getBoundingClientRect();
  const count = Math.max(1, Math.round(box.height / lineHeight));
  const lines: TextLine[] = Array.from({ length: count }, () => ({ text: "", start: -1, end: -1, runs: [] }));
  const range = document.createRange();
  let offset = 0;
  let previousRow = 0;
  let run: { text: string; x: number } | null = null;
  for (const char of Array.from(s.text + "\u200b")) {
    range.setStart(node, offset);
    range.setEnd(node, offset + char.length);
    const rect = range.getBoundingClientRect();
    const row = Math.max(0, Math.min(count - 1, Math.round((rect.top - box.top) / lineHeight)));
    const line = lines[row];
    if (line.start < 0) line.start = offset;
    if (row !== previousRow) run = null;
    if (char !== "\n" && offset < s.text.length) {
      line.text += char;
      if (char === "\t") run = null;
      else {
        if (!run) { run = { text: "", x: rect.left - box.left }; line.runs.push(run); }
        run.text += char;
      }
    } else run = null;
    line.end = Math.min(s.text.length, offset + (char === "\n" ? 0 : char.length));
    previousRow = row;
    offset += char.length;
  }
  context!.font = `${s.fontSize}px ${TEXT_FONT}`;
  const metrics = context!.measureText("Mg");
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
  const contentHeight = count * lineHeight;
  const result = {
    w: s.textMode === "frame" ? Math.max(TEXT_MIN_WIDTH, s.width) : Math.max(1, Math.ceil(box.width)),
    h: Math.max(s.minHeight, contentHeight), contentHeight, lineHeight,
    baseline: (lineHeight - ascent - descent) / 2 + ascent, lines,
  };
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

export function textBounds(s: TextShape): Bounds {
  const { w, h } = layoutText(s);
  return { x: s.p1.x, y: s.p1.y, w, h };
}

export function drawText(ctx: CanvasRenderingContext2D, s: TextShape, k: number) {
  const layout = layoutText(s);
  ctx.save();
  ctx.scale(k, k);
  ctx.font = `${s.fontSize}px ${TEXT_FONT}`;
  ctx.fillStyle = s.color;
  ctx.textBaseline = "alphabetic";
  layout.lines.forEach((line, row) => line.runs.forEach((run) =>
    ctx.fillText(run.text, s.p1.x + run.x, s.p1.y + layout.baseline + row * layout.lineHeight),
  ));
  ctx.restore();
}

export function resizeText(original: TextShape, handle: TextHandle, start: Pt, pt: Pt): TextShape {
  const bounds = textBounds(original);
  const dx = pt.x - start.x;
  const dy = pt.y - start.y;
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  const width = Math.max(TEXT_MIN_WIDTH, bounds.w + (east ? dx : west ? -dx : 0));
  const next: TextShape = { ...original, textMode: "frame", width,
    minHeight: Math.max(0, bounds.h + (south ? dy : north ? -dy : 0)) };
  const height = layoutText(next).h;
  const p1 = { x: west ? bounds.x + bounds.w - width : bounds.x,
    y: north ? bounds.y + bounds.h - height : bounds.y };
  return { ...next, p1, p2: p1 };
}

/** Map the double-click point to an offset in the original (unwrapped) text. */
export function caretAtPoint(s: TextShape, pt: Pt): number {
  const layout = layoutText(s);
  const row = Math.max(0, Math.min(layout.lines.length - 1, Math.floor((pt.y - s.p1.y) / layout.lineHeight)));
  const line = layout.lines[row];
  const start = Math.max(0, line.start);
  const end = Math.max(start, line.end);
  context!.font = `${s.fontSize}px ${TEXT_FONT}`;
  let best = start;
  let distance = Infinity;
  const range = document.createRange();
  // Rebuild the native mirror if another element was measured since this cache hit.
  mirror!.style.width = s.textMode === "frame" ? `${s.width}px` : "max-content";
  mirror!.style.whiteSpace = s.textMode === "frame" ? "pre-wrap" : "pre";
  mirror!.style.fontSize = `${s.fontSize}px`;
  mirror!.style.lineHeight = `${layout.lineHeight}px`;
  const node = document.createTextNode(s.text + "\u200b");
  mirror!.replaceChildren(node);
  const left = mirror!.getBoundingClientRect().left;
  let offset = start;
  for (const char of Array.from(s.text.slice(start, end) + "\u200b")) {
    range.setStart(node, Math.min(offset, s.text.length));
    range.setEnd(node, Math.min(offset + char.length, s.text.length + 1));
    const x = range.getBoundingClientRect().left - left;
    const d = Math.abs(pt.x - s.p1.x - x);
    if (d < distance) { distance = d; best = offset; }
    offset += char.length;
  }
  return Math.min(best, s.text.length);
}
