export type NativeRect={x:number;y:number;width:number;height:number};
export type PinEditGeometry={sessionId:number;revision:number;x:number;y:number;width:number;height:number;imageRect:NativeRect;panelBounds:NativeRect};

/** Wait for the new DOM frame before uncovering the window. */
export async function waitForPinPaint(image:HTMLImageElement|null) {
  if(image&&!image.complete)await image.decode().catch(()=>{});
  const frame=()=>new Promise<void>(resolve=>{
    let raf=0;const finish=()=>{clearTimeout(timer);cancelAnimationFrame(raf);resolve();};
    // WebView can pause RAF while the native window is fully clipped.
    const timer=window.setTimeout(finish,80);raf=requestAnimationFrame(finish);
  });
  await frame();await frame();
}
