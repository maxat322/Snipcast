import {useCallback,useEffect,useRef} from "react";
export function useQuickSaveHover(open:(value:boolean)=>void,disabled:boolean){
  const timer=useRef(0),close=useRef(0),disabledRef=useRef(disabled);disabledRef.current=disabled;
  const cancel=useCallback(()=>{clearTimeout(timer.current);clearTimeout(close.current);timer.current=close.current=0;},[]);
  const enter=()=>{clearTimeout(close.current);if(disabledRef.current)return;clearTimeout(timer.current);timer.current=window.setTimeout(()=>{if(!disabledRef.current)open(true);},250);};
  const leave=()=>{clearTimeout(timer.current);clearTimeout(close.current);close.current=window.setTimeout(()=>open(false),150);};
  const menuEnter=()=>{clearTimeout(timer.current);clearTimeout(close.current);};
  useEffect(()=>{if(disabled){cancel();open(false);}},[disabled,cancel,open]);
  useEffect(()=>cancel,[cancel]);
  useEffect(()=>{const dismiss=()=>{cancel();open(false);};window.addEventListener("blur",dismiss);window.addEventListener("pointercancel",dismiss);
    return()=>{window.removeEventListener("blur",dismiss);window.removeEventListener("pointercancel",dismiss);};},[cancel,open]);
  return {enter,leave,menuEnter,cancel};
}
