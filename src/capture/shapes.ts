/**
 * Векторные аннотации для скриншота: модель, отрисовка на Canvas2D и хит-тесты.
 * Все координаты фигур — в CSS-пикселях окна; физический масштаб `k`
 * (≈ devicePixelRatio) применяется только при отрисовке.
 */

export type ShapeKind = "line" | "rect" | "square" | "ellipse" | "circle" | "arrow" | "freehand" | "text";
export type Pt = { x: number; y: number };
type ShapeBase = { id: number; color: string; p1: Pt; p2: Pt; opacity?: number };
export type DrawShape = ShapeBase & { kind: Exclude<ShapeKind, "text">; thickness: number; filled?: boolean; points?: Pt[]; straightPrefix?:number };
export type TextShape = ShapeBase & {
  kind: "text";
  /** Original text, including hard line breaks; soft breaks belong to layout. */
  text: string;
  /** p1 is the top-left corner in CSS pixels, not a baseline. */
  fontSize: number;
  textMode: "auto" | "frame";
  width: number;
  minHeight: number;
  outlineColor?: string;
  outlineWidth?: number;
};
export type Shape = DrawShape | TextShape;
export type Bounds = { x: number; y: number; w: number; h: number };

import { drawText, textBounds } from "./textLayout";
export { textBounds } from "./textLayout";

export function shapeBounds(s: Shape): Bounds {
  if (s.kind === "text") return textBounds(s);
  if (s.kind === "freehand" && s.points?.length) {
    return freehandGeometry(s.points,s.straightPrefix).bounds;
  }
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

// One geometry drives live rendering, export and picking. Cache completed
// strokes by their immutable points array; moving a stroke produces a new key.
const freehandCache = new WeakMap<Pt[], { path: Path2D; hitPoints: Pt[]; bounds:Bounds; straightPrefix:number }>();
export function freehandGeometry(inputPoints: Pt[], straightPrefix=0) {
  const cached = freehandCache.get(inputPoints);
  if (cached?.straightPrefix===straightPrefix) return cached;
  // Keep the gesture untouched. Resampling by distance makes the filter
  // independent of event frequency and repeated coalesced samples.
  const points:Pt[]=[];
  let prefix=0;
  inputPoints.forEach((point,i)=>{
    const last=points[points.length-1];
    if(!last||point.x!==last.x||point.y!==last.y){points.push(point);if(i<=straightPrefix)prefix=points.length-1;}
  });
  const path = new Path2D(), hitPoints: Pt[] = [];
  const first = points[0];
  if (!first) return { path, hitPoints, bounds:{x:0,y:0,w:0,h:0},straightPrefix };
  path.moveTo(first.x, first.y); hitPoints.push(first);
  let left=first.x,top=first.y,right=first.x,bottom=first.y;
  const include=(p:Pt)=>{left=Math.min(left,p.x);top=Math.min(top,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);};
  const midpoint=(a:Pt,b:Pt):Pt=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const flatten = (a: Pt, c1: Pt, c2:Pt, b: Pt, depth = 0) => {
    if (depth >= 10 || Math.max(distToSegment(c1.x,c1.y,a.x,a.y,b.x,b.y),distToSegment(c2.x,c2.y,a.x,a.y,b.x,b.y)) <= .25) {
      hitPoints.push(b); return;
    }
    const ac=midpoint(a,c1),cc=midpoint(c1,c2),cb=midpoint(c2,b);
    const l=midpoint(ac,cc),r=midpoint(cc,cb),mid=midpoint(l,r);
    flatten(a,ac,l,mid,depth+1);flatten(mid,r,cb,b,depth+1);
  };
  // Exact extrema of the same cubic path, rather than the raw mouse vertices.
  const cubicBounds=(a:Pt,c1:Pt,c2:Pt,b:Pt)=>{
    include(b);
    for(const axis of ["x","y"] as const){
      const A=-a[axis]+3*c1[axis]-3*c2[axis]+b[axis];
      const B=2*(a[axis]-2*c1[axis]+c2[axis]),C=c1[axis]-a[axis];
      const disc=B*B-4*A*C;
      const roots=Math.abs(A)<1e-9?(Math.abs(B)<1e-9?[]:[-C/B]):disc<0?[]:[(-B+Math.sqrt(disc))/(2*A),(-B-Math.sqrt(disc))/(2*A)];
      for(const t of roots)if(t>0&&t<1){const u=1-t;include({x:u*u*u*a.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*b.x,y:u*u*u*a.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*b.y});}
    }
  };
  let start = first;
  for(let i=1;i<=prefix&&i<points.length;i++){
    start=points[i]!;path.lineTo(start.x,start.y);hitPoints.push(start);include(start);
  }
  const last=points[points.length-1]!;
  const uniform:Pt[]=[start];let remaining=4;
  for(let i=prefix+1;i<points.length;i++){
    let a=points[i-1]!;const b=points[i]!;let distance=Math.hypot(b.x-a.x,b.y-a.y);
    while(distance>=remaining){
      const t=remaining/distance;a={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};uniform.push(a);
      distance=Math.hypot(b.x-a.x,b.y-a.y);remaining=4;
    }
    remaining-=distance;
  }
  const tail=uniform[uniform.length-1]!;
  if(tail.x!==last.x||tail.y!==last.y)uniform.push(last);
  const weights=Array.from({length:7},(_,i)=>Math.exp(-((i-3)**2)/(2*1.5**2)));
  const weightSum=weights.reduce((a,b)=>a+b,0);
  const filtered=uniform.map((point,i)=>{
    if(i===0||i===uniform.length-1)return point; // pointer and initial anchor stay exact
    let x=0,y=0;
    weights.forEach((weight,j)=>{const p=uniform[Math.max(0,Math.min(uniform.length-1,i+j-3))]!;x+=p.x*weight;y+=p.y*weight;});
    return {x:x/weightSum,y:y/weightSum};
  });
  // A uniform cubic B-spline with tripled end controls is clamped to both
  // anchors. Convert to Beziers once for Canvas, picking and exact bounds.
  if(filtered.length>1){
    const controls=[filtered[0]!,filtered[0]!,...filtered,last,last];
    for(let i=0;i<controls.length-3;i++){
      const b=controls[i+1]!,c=controls[i+2]!,d=controls[i+3]!;
      const c1={x:(2*b.x+c.x)/3,y:(2*b.y+c.y)/3};
      const c2={x:(b.x+2*c.x)/3,y:(b.y+2*c.y)/3};
      const end={x:(b.x+4*c.x+d.x)/6,y:(b.y+4*c.y+d.y)/6};
      path.bezierCurveTo(c1.x,c1.y,c2.x,c2.y,end.x,end.y);
      cubicBounds(start,c1,c2,end);flatten(start,c1,c2,end);start=end;
    }
  }else if(points.length===1){path.lineTo(first.x+.01,first.y);}
  const bounds={x:left,y:top,w:right-left,h:bottom-top};
  const result={path,hitPoints,bounds,straightPrefix};freehandCache.set(inputPoints,result);return result;
}

// Supersample only the stroke's bounding box, sharing one scratch buffer
// across previews and export. Large strokes cap the extra buffer at ~16 MB.
let strokeSurface:HTMLCanvasElement|null=null;
function paintFreehand(ctx:CanvasRenderingContext2D,s:DrawShape) {
  const path=freehandGeometry(s.points??[s.p1,s.p2],s.straightPrefix).path;
  const transform=ctx.getTransform(),scale=Math.max(Math.abs(transform.a),Math.abs(transform.d))||1;
  const bounds=shapeBounds(s),pad=Math.ceil(Math.max(1,s.thickness)*scale/2)+2;
  const left=Math.floor(bounds.x*scale)-pad,top=Math.floor(bounds.y*scale)-pad;
  const width=Math.max(1,Math.ceil((bounds.x+bounds.w)*scale)+pad-left);
  const height=Math.max(1,Math.ceil((bounds.y+bounds.h)*scale)+pad-top);
  const samples=Math.min(4,Math.floor(Math.sqrt(4_000_000/(width*height))));
  if(samples<2){ctx.stroke(path);return;}
  const surface=strokeSurface??(strokeSurface=document.createElement("canvas"));
  const w=width*samples,h=height*samples;
  // Grow in small blocks so dragging doesn't allocate a new canvas per pixel.
  if(Math.max(surface.width,w)*Math.max(surface.height,h)>4_500_000){
    surface.width=w;surface.height=h;
  }
  if(surface.width<w)surface.width=Math.ceil(w/64)*64;
  if(surface.height<h)surface.height=Math.ceil(h/64)*64;
  const ink=surface.getContext("2d");if(!ink){ctx.stroke(path);return;}
  ink.resetTransform();ink.clearRect(0,0,w,h);
  ink.setTransform(scale*samples,0,0,scale*samples,-left*samples,-top*samples);
  ink.strokeStyle=s.color;ink.lineWidth=Math.max(1,s.thickness);ink.lineCap="round";ink.lineJoin="round";
  ink.stroke(path);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  ctx.drawImage(surface,0,0,w,h,left/scale,top/scale,width/scale,height/scale);
}

/**
 * Рисует одну фигуру на контексте. `k` — физический масштаб: все CSS-координаты
 * и размеры умножаются на него (k=1, если контекст уже отмасштабирован).
 */
let opacitySurface:HTMLCanvasElement|null=null;
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape, k: number): void {
  const opacity=Math.max(0,Math.min(1,s.opacity??1));
  if(opacity===0)return;
  if(opacity<1){
    const b=shapeBounds(s),t=ctx.getTransform(),scale=Math.max(Math.hypot(t.a,t.b),Math.hypot(t.c,t.d),1)*k;
    const pad=4+(s.kind==="text"?(s.outlineWidth??0):Math.max(s.thickness,s.kind==="arrow"?arrowHeadLen(s.thickness):0));
    const left=Math.floor((b.x-pad)*scale),top=Math.floor((b.y-pad)*scale),width=Math.max(1,Math.ceil((b.x+b.w+pad)*scale)-left),height=Math.max(1,Math.ceil((b.y+b.h+pad)*scale)-top);
    const layer=opacitySurface??(opacitySurface=document.createElement("canvas"));
    if(layer.width!==width)layer.width=width;if(layer.height!==height)layer.height=height;
    const ink=layer.getContext("2d");if(ink){
      ink.resetTransform();ink.clearRect(0,0,width,height);ink.setTransform(scale,0,0,scale,-left,-top);
      drawShape(ink,{...s,opacity:1},1);
      ctx.save();ctx.globalAlpha*=opacity;ctx.drawImage(layer,left/scale*k,top/scale*k,width/scale*k,height/scale*k);ctx.restore();return;
    }
  }
  ctx.save();
  ctx.globalAlpha*=opacity;
  const x1 = s.p1.x * k;
  const y1 = s.p1.y * k;
  const x2 = s.p2.x * k;
  const y2 = s.p2.y * k;

  if (s.kind === "text") {
    drawText(ctx, s, k);
    ctx.restore();
    return;
  }
  const th = Math.max(1, s.thickness) * k;

  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = th;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (s.kind === "freehand") {
    const points=s.points??[s.p1,s.p2];
    ctx.scale(k,k);ctx.lineWidth=Math.max(1,s.thickness);
    paintFreehand(ctx,{...s,points});
  } else if (s.kind === "line") {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  } else if (s.kind === "rect" || s.kind === "square") {
    const rx = Math.min(x1, x2);
    const ry = Math.min(y1, y2);
    if(s.filled)ctx.fillRect(rx,ry,Math.abs(x2-x1),Math.abs(y2-y1));
    else ctx.strokeRect(rx, ry, Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (s.kind === "ellipse" || s.kind === "circle") {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    if(s.filled)ctx.fill();else ctx.stroke();
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
  if(s.kind==="freehand") {
    const points=freehandGeometry(s.points??[s.p1,s.p2],s.straightPrefix).hitPoints;
    return points.some((p,i)=>i===0?Math.hypot(pt.x-p.x,pt.y-p.y)<=tol:
      distToSegment(pt.x,pt.y,points[i-1]!.x,points[i-1]!.y,p.x,p.y)<=tol);
  }
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
    if(s.filled&&withinX&&withinY)return true;
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
    if(s.filled&&nr<=1)return true;
    return Math.abs(nr - 1) * Math.min(rx, ry) <= Math.max(6, tol);
  }

  const onShaft = distToSegment(pt.x, pt.y, s.p1.x, s.p1.y, s.p2.x, s.p2.y) <= tol;
  if (onShaft) return true;
  if (s.kind === "arrow") {
    return Math.hypot(pt.x - s.p2.x, pt.y - s.p2.y) <= arrowHeadLen(s.thickness) + 4;
  }
  return false;
}
