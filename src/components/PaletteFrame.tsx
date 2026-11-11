import type {ComponentProps, ReactNode} from 'react';

/** The ordinary template palette's existing shell. Both palettes render this. */
export function PaletteFrame({className='', ...props}:ComponentProps<'div'>){
 return <div {...props} className={`palette ${className}`.trim()} data-tauri-drag-region onContextMenu={e=>e.preventDefault()}/>;
}
export function PaletteChrome({children}: {children:ReactNode}){return <header className="palette__chrome">{children}</header>}
export function PaletteBackButton({className='',...props}:ComponentProps<'button'>){
 return <button type="button" aria-label="Назад" title="Назад" data-tauri-drag-region="false" {...props} className={`palette__back ${className}`.trim()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m14.5 5-7 7 7 7"/></svg></button>;
}
export function PaletteSearch({children,...input}:ComponentProps<'input'> & {children?:ReactNode}){
 return <div className="palette__search-wrap"><span className="palette__search-icon" aria-hidden>🔎</span><input {...input} className="palette__search" type="text" data-tauri-drag-region="false" autoComplete="off" spellCheck={false}/>{children}</div>;
}
export function PaletteHints({primary='вставить',primaryKeys=['Enter'],back=false,groups=true,onPrimary,onSettings,children}:{primary?:string;primaryKeys?:string[];back?:boolean;groups?:boolean;onPrimary?:()=>void;onSettings?:()=>void;children?:ReactNode}){
 return <footer className="palette__hints"><span>навигация <kbd>↑</kbd> <kbd>↓</kbd></span><span onClick={onPrimary}>{primary} {primaryKeys.map(key=><kbd key={key}>{key}</kbd>)}</span><span>{back?'назад':'закрыть'} <kbd>Esc</kbd></span>{groups&&<span>группы <kbd>Tab</kbd></span>}{children}<span className="palette__hints-muted palette__hints-settings" onClick={onSettings}>настройки <kbd>{/Mac|iPhone|iPad/.test(navigator.userAgent)?'⌘':'Ctrl'}</kbd><kbd>K</kbd></span></footer>;
}

export function PaletteItemText({title,preview}:{title:ReactNode;preview?:ReactNode}){return <div className="palette__item-text"><div className="palette__item-title">{title}</div>{preview!=null&&<div className="palette__item-preview">{preview}</div>}</div>}

export function PaletteCalculation({expression,result}:{expression:string;result:string}){
 return <><span>{expression}<small>Выражение</small></span><span>→</span><span>{result}<small>Результат</small></span></>;
}
