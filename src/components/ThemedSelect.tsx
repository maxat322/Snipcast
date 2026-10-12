import {useEffect,useId,useRef,useState,type KeyboardEvent} from "react";
import "./themed-select.css";

export function ThemedSelect({label,value,options,onChange,disabled=false}:{label:string;value:string;options:{value:string;label:string}[];onChange:(value:string)=>void;disabled?:boolean}) {
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
  const [open,setOpen]=useState(false),[active,setActive]=useState(0),[above,setAbove]=useState(false);
  const selected=Math.max(0,options.findIndex(o=>o.value===value));
  const show=()=>{if(disabled)return;const rect=root.current!.getBoundingClientRect();setAbove(rect.bottom+options.length*34+16>innerHeight);setActive(selected);setOpen(true);};
  const choose=(index:number)=>{onChange(options[index].value);setOpen(false);trigger.current?.focus();};
  useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener("pointerdown",outside);return()=>document.removeEventListener("pointerdown",outside);},[open]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  const key=(e:KeyboardEvent)=>{if(!["ArrowDown","ArrowUp","Enter"," ","Escape","Home","End"].includes(e.key))return;
    e.preventDefault();e.stopPropagation();
    if(e.key==="Escape"){setOpen(false);trigger.current?.focus();return;}
    if(e.key==="Enter"||e.key===" "){if(open)choose(active);else show();return;}
    if(!open){show();return;}
    setActive(i=>e.key==="Home"?0:e.key==="End"?options.length-1:(i+(e.key==="ArrowUp"?-1:1)+options.length)%options.length);
  };
  return <div className="snip-select" ref={root} onKeyDown={key}>
    <button ref={trigger} type="button" className="snip-select__trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox" aria-activedescendant={open?`${id}-${active}`:undefined} disabled={disabled} onClick={()=>open?setOpen(false):show()}>
      <span>{options[selected]?.label}</span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5"/></svg>
    </button>
    {open?<div id={id} role="listbox" aria-label={label} className={`snip-select__menu${above?" is-above":""}`}>
      {options.map((o,i)=><button type="button" key={o.value} id={`${id}-${i}`} role="option" aria-selected={value===o.value} tabIndex={-1} className={`snip-select__option${active===i?" is-active":""}`} onPointerMove={()=>setActive(i)} onClick={()=>choose(i)}><span>{o.label}</span><span aria-hidden>{o.value===value?"✓":""}</span></button>)}
    </div>:null}
  </div>;
}
