import type {AppConfig} from "../types";
import {keyboardEventToTauriHotkey,tauriHotkeyToDisplay} from "../hotkeyFormat";
export type CaptureAction="save"|"pin"|"copy";
const defaults={save:"Enter",pin:"Space",copy:"C"};
const fields={save:"screenshotSaveHotkey",pin:"screenshotPinHotkey",copy:"screenshotCopyHotkey"} as const;
export const actionHotkey=(cfg:AppConfig|null,action:CaptureAction)=>cfg?.[fields[action]]??defaults[action];
export const actionHotkeyLabel=(cfg:AppConfig|null,action:CaptureAction)=>tauriHotkeyToDisplay(actionHotkey(cfg,action));
const normalized=(s:string)=>s.toUpperCase().replace(/(?:COMMANDORCONTROL|CTRL|CONTROL|META|COMMAND)/g,"CTRL").split("+").filter(Boolean).sort().join("+");
export function matchesAction(e:KeyboardEvent,cfg:AppConfig|null,action:CaptureAction){
  const value=actionHotkey(cfg,action);if(!value||e.repeat)return false;
  const actual=keyboardEventToTauriHotkey(e);if(!actual)return false;
  return normalized(value)===normalized(actual)||e.altKey&&normalized(value)===normalized(actual.replace(/(?:^|\+)Alt(?=\+|$)/,"" ).replace(/^\+/,""));
}
export function drawCenterGuides(ctx:CanvasRenderingContext2D,r:{x:number;y:number;w:number;h:number},pixelScale=1){
  ctx.save();ctx.strokeStyle="#3b82f6";ctx.lineWidth=1/pixelScale;ctx.setLineDash([8/pixelScale,6/pixelScale]);
  ctx.beginPath();ctx.moveTo(r.x+r.w/2,0);ctx.lineTo(r.x+r.w/2,r.y+r.h);ctx.moveTo(0,r.y+r.h/2);ctx.lineTo(r.x+r.w,r.y+r.h/2);ctx.stroke();ctx.restore();
}
