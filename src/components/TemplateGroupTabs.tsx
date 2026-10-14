import {useEffect, useRef, useState, type PointerEvent, type CSSProperties} from "react";
import type {TemplateGroup} from "../types";

type Drop = {id: string; after: boolean};
export function TemplateGroupTabs({groups, selectedId, saving, onSelect, onMove}: {
  groups: TemplateGroup[];
  selectedId: string | null;
  saving: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, target: string, after: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const gesture = useRef<{id: string; pointer: number; startX: number; startY: number; x: number; y: number; active: boolean} | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const clear = () => {
    if (gesture.current?.active) suppressClick.current = true;
    gesture.current = null;
    dropRef.current = null;
    setDragging(null);
    setDrop(null);
  };
  const findDrop = () => {
    const g = gesture.current, list = container.current;
    let next: Drop | null = null;
    if (g && list) {
      const bounds = list.getBoundingClientRect();
      if (g.x >= bounds.left && g.x <= bounds.right && g.y >= bounds.top - 8 && g.y <= bounds.bottom + 8) {
        let distance = Infinity;
        for (const button of list.querySelectorAll<HTMLButtonElement>("[data-group-id]")) {
          const rect = button.getBoundingClientRect();
          const d = Math.max(rect.left - g.x, 0, g.x - rect.right);
          if (d < distance) {
            distance = d;
            next = {id: button.dataset.groupId!, after: g.x > rect.left + rect.width / 2};
          }
        }
      }
    }
    dropRef.current = next;
    setDrop(previous => previous?.id === next?.id && previous?.after === next?.after ? previous : next);
  };

  useEffect(() => {
    const cancel = () => clear();
    const escape = (event: KeyboardEvent) => {
      if (event.code === "Escape" && gesture.current) {event.preventDefault(); clear();}
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {window.removeEventListener("blur", cancel); window.removeEventListener("keydown", escape);};
  }, []);

  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const scroll = () => {
      const g = gesture.current, list = container.current;
      if (!g || !list) return;
      const bounds = list.getBoundingClientRect();
      if (g.y >= bounds.top - 8 && g.y <= bounds.bottom + 8 && g.x >= bounds.left && g.x <= bounds.right) {
        const speed = g.x < bounds.left + 24 ? -8 : g.x > bounds.right - 24 ? 8 : 0;
        if (speed) {list.scrollLeft += speed; findDrop();}
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    g.x = event.clientX; g.y = event.clientY;
    if (!g.active && Math.hypot(g.x - g.startX, g.y - g.startY) >= 5) {
      g.active = true; setDragging(g.id);
    }
    if (g.active) {event.preventDefault(); findDrop();}
  };
  const end = (event: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    if (g.active) {
      move(event);
      const target = dropRef.current;
      suppressClick.current = true;
      if (target && target.id !== g.id) onMove(g.id, target.id, target.after);
    }
    clear();
  };

  return <div className={`settings__group-tags${dragging ? " is-dragging" : ""}`} ref={container} aria-label="Группы шаблонов">
    {groups.map(group => <button key={group.id} type="button" data-group-id={group.id}
      className={`settings__group-tag${selectedId === group.id ? " is-active" : ""}${dragging === group.id ? " is-dragging" : ""}${drop?.id === group.id && drop.id !== dragging ? (drop.after ? " is-drop-after" : " is-drop-before") : ""}`}
      style={{"--tag-color": group.color} as CSSProperties}
      title="Перетащите, чтобы изменить порядок групп" aria-pressed={selectedId === group.id}
      onClick={() => {
        if (suppressClick.current) {suppressClick.current = false; return;}
        onSelect(group.id);
      }}
      onPointerDown={event => {
        if (event.button !== 0 || saving) return;
        suppressClick.current = false;
        gesture.current = {id: group.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false};
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={move} onPointerUp={end} onPointerCancel={clear} onLostPointerCapture={clear}>
      {group.title}{group.isMaster ? " •M" : ""}
    </button>
    )}
  </div>;
}
