import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TemplateChild, TemplateRow } from "./types";
import "./App.css";

function IconFolderOutline({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M4 7.5C4 6.67 4.67 6 5.5 6h4.09c.4 0 .78.16 1.06.44l1.41 1.41c.28.28.66.44 1.06.44H18.5c.83 0 1.5.67 1.5 1.5v7.5c0 .83-.67 1.5-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5V7.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Уникальные корневые шаблоны по id (первый экземпляр), чтобы не дублировать строки из master+user. */
function dedupeTemplatesById(rows: TemplateRow[]): TemplateRow[] {
  const seen = new Set<string>();
  const out: TemplateRow[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

type SearchEntry =
  | { kind: "section"; key: string; title: string }
  | {
      kind: "hit";
      key: string;
      title: string;
      preview: string;
      pasteText: string;
    };

type VisibleRow =
  | { kind: "top"; row: TemplateRow }
  | { kind: "nested"; parent: TemplateRow; child: TemplateChild };

function getPasteText(row: TemplateRow | TemplateChild): string {
  if ("children" in row && row.children && row.children.length > 0) {
    return row.pasteText ?? "";
  }
  if ("pasteText" in row && row.pasteText !== undefined) {
    return row.pasteText;
  }
  return "";
}

/** Результаты поиска: подзаголовки секций + только вставляемые «хиты» (навигация только по hit). */
function buildSearchEntries(rows: TemplateRow[], query: string): SearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const out: SearchEntry[] = [];
  const usedHitKeys = new Set<string>();

  for (const r of rows) {
    const matchSelf =
      r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q);
    const childMatches =
      r.children?.filter(
        (c) =>
          c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q),
      ) ?? [];
    const hasKids = !!(r.children && r.children.length > 0);
    const parentPaste = getPasteText(r).trim();

    const pushHit = (key: string, title: string, preview: string, pasteText: string) => {
      const pt = pasteText.trim();
      if (!pt || usedHitKeys.has(key)) return;
      usedHitKeys.add(key);
      out.push({ kind: "hit", key, title, preview, pasteText: pt });
    };

    if (hasKids) {
      const kidsToShow =
        childMatches.length > 0
          ? childMatches
          : matchSelf
            ? r.children!
            : [];

      if (kidsToShow.length > 0) {
        const before = out.length;
        out.push({ kind: "section", key: `sec-${r.id}`, title: r.title });
        for (const c of kidsToShow) {
          pushHit(`hit-${r.id}-${c.id}`, c.title, c.preview, getPasteText(c));
        }
        if (out.length === before + 1) {
          out.pop();
        }
      } else if (matchSelf && parentPaste) {
        pushHit(`hit-${r.id}-self`, r.title, r.preview, parentPaste);
      }
    } else if (matchSelf && parentPaste) {
      pushHit(`hit-${r.id}-leaf`, r.title, r.preview, parentPaste);
    }
  }

  return out;
}

function searchHitsOnly(entries: SearchEntry[]) {
  return entries.filter((e): e is Extract<SearchEntry, { kind: "hit" }> => e.kind === "hit");
}

function browseRows(templates: TemplateRow[], drill: TemplateRow | null): VisibleRow[] {
  if (!drill) {
    return templates.map((row) => ({ kind: "top", row }));
  }
  return (drill.children ?? []).map((child) => ({
    kind: "nested",
    parent: drill,
    child,
  }));
}

function visibleRowId(v: VisibleRow): string {
  if (v.kind === "top") return `t-${v.row.id}`;
  return `n-${v.parent.id}-${v.child.id}`;
}

function visiblePasteText(v: VisibleRow): string {
  if (v.kind === "top") return getPasteText(v.row);
  return v.child.pasteText ?? "";
}

function visibleTitle(v: VisibleRow): string {
  if (v.kind === "top") return v.row.title;
  return v.child.title;
}

function visiblePreview(v: VisibleRow): string {
  if (v.kind === "top") return v.row.preview;
  return v.child.preview;
}

function visibleHasChildren(v: VisibleRow): boolean {
  return v.kind === "top" && !!(v.row.children && v.row.children.length > 0);
}

function App() {
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const selectedIndexRef = useRef(0);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [varMap, setVarMap] = useState<Record<string, string>>({});
  const [drill, setDrill] = useState<TemplateRow | null>(null);

  const uniqueTemplates = useMemo(() => dedupeTemplatesById(templates), [templates]);
  const searching = query.trim().length > 0;
  const searchEntries = useMemo(
    () => buildSearchEntries(uniqueTemplates, query),
    [uniqueTemplates, query],
  );
  const searchHits = useMemo(() => searchHitsOnly(searchEntries), [searchEntries]);

  const filteredBrowse = useMemo(
    () => browseRows(uniqueTemplates, searching ? null : drill),
    [uniqueTemplates, drill, searching],
  );

  const activeList: "search" | "browse" = searching ? "search" : "browse";
  const browseLength = filteredBrowse.length;
  const searchHitLength = searchHits.length;

  selectedIndexRef.current = selectedIndex;

  const reloadData = useCallback(async () => {
    try {
      const [rows, vars] = await Promise.all([
        invoke<TemplateRow[]>("snipcast_list_templates"),
        invoke<Record<string, unknown>>("snipcast_get_variables"),
      ]);
      setTemplates(rows);
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) {
        m[k] = typeof v === "string" ? v : String(v);
      }
      setVarMap(m);
    } catch {
      /* offline / dev */
    }
  }, []);

  const substituteVars = useCallback(
    (text: string) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => varMap[key] ?? `{${key}}`),
    [varMap],
  );

  const hide = useCallback(() => {
    void invoke("palette_hide");
  }, []);

  const openSettings = useCallback(() => {
    void invoke("snipcast_open_settings");
  }, []);

  const insertTemplate = useCallback(
    async (raw: string) => {
      const text = substituteVars(raw).trim();
      if (!text) return;
      try {
        await invoke("paste_template", { text });
      } catch {
        /* см. README: macOS — доступ */
      }
    },
    [substituteVars],
  );

  useEffect(() => {
    void reloadData();
  }, [reloadData]);

  const navLength = activeList === "search" ? searchHitLength : browseLength;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, drill, searching, navLength]);

  useEffect(() => {
    if (navLength === 0) return;
    setSelectedIndex((i) => Math.min(i, navLength - 1));
  }, [navLength]);

  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIndex, activeList, searchEntries, filteredBrowse]);

  useEffect(() => {
    let unlistenFocus: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          setQuery("");
          setDrill(null);
          setSelectedIndex(0);
          void reloadData();
          queueMicrotask(() => {
            searchRef.current?.focus();
            searchRef.current?.select();
          });
        }
      })
      .then((fn) => {
        unlistenFocus = fn;
      });

    return () => {
      unlistenFocus?.();
    };
  }, [reloadData]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (drill && !searching) {
          setDrill(null);
          setSelectedIndex(0);
          return;
        }
        hide();
        return;
      }

      const modDown = e.metaKey || e.ctrlKey;
      if (modDown && e.code === "KeyK") {
        e.preventDefault();
        openSettings();
        return;
      }

      if (navLength === 0) return;

      const inSearch = e.target instanceof HTMLInputElement && e.target === searchRef.current;
      if (e.key === "Backspace" && inSearch) {
        const len = searchRef.current?.value.length ?? 0;
        if (len > 0) return;
        if (drill) {
          e.preventDefault();
          setDrill(null);
          setSelectedIndex(0);
          return;
        }
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % navLength);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + navLength) % navLength);
        return;
      }

      if (e.key === "ArrowLeft" && !searching && drill) {
        e.preventDefault();
        setDrill(null);
        setSelectedIndex(0);
        return;
      }

      if (e.key === "Backspace" && !searching && drill && !inSearch) {
        e.preventDefault();
        setDrill(null);
        setSelectedIndex(0);
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const idx = selectedIndexRef.current;
        if (activeList === "search") {
          const hit = searchHits[idx];
          if (hit) void insertTemplate(hit.pasteText);
          return;
        }
        const v = filteredBrowse[idx] as VisibleRow | undefined;
        if (!v) return;
        if (visibleHasChildren(v)) {
          setDrill((v as { kind: "top"; row: TemplateRow }).row);
          setSelectedIndex(0);
          return;
        }
        const pt = visiblePasteText(v);
        if (pt.trim()) void insertTemplate(pt);
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    navLength,
    hide,
    insertTemplate,
    openSettings,
    activeList,
    searchHits,
    filteredBrowse,
    searching,
    drill,
  ]);

  const activeHit = searching ? searchHits[selectedIndex] : undefined;
  const activeDescendantId =
    navLength > 0
      ? activeList === "search" && activeHit
        ? `snipcast-hit-${activeHit.key}`
        : `snipcast-opt-${visibleRowId(filteredBrowse[selectedIndex] as VisibleRow)}`
      : undefined;

  const settingsKbd = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K";

  let hitNavIndex = 0;

  return (
    <div className="palette">
      <header className="palette__chrome" data-tauri-drag-region>
        {drill && !searching ? (
          <div className="palette__breadcrumb">
            <button
              type="button"
              className="palette__back"
              onClick={() => {
                setDrill(null);
                setSelectedIndex(0);
              }}
            >
              ← {drill.title}
            </button>
          </div>
        ) : null}
        <input
          ref={searchRef}
          className="palette__search"
          type="text"
          placeholder="🔎 Поиск по шаблонам..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDrill(null);
          }}
          autoComplete="off"
          spellCheck={false}
          aria-controls="snipcast-listbox"
          aria-activedescendant={activeDescendantId}
        />
      </header>

      <ul
        id="snipcast-listbox"
        className="palette__list"
        role="listbox"
        aria-label="Шаблоны"
      >
        {activeList === "search" ? (
          searchHitLength === 0 ? (
            <li className="palette__empty">Нет совпадений</li>
          ) : (
            searchEntries.map((entry) => {
              if (entry.kind === "section") {
                return (
                  <li key={entry.key} className="palette__section" role="presentation">
                    <span className="palette__section-title">{entry.title}</span>
                  </li>
                );
              }
              const myIndex = hitNavIndex++;
              const isSel = myIndex === selectedIndex;
              return (
                <li
                  key={entry.key}
                  id={`snipcast-hit-${entry.key}`}
                  ref={(el) => {
                    itemRefs.current[myIndex] = el;
                  }}
                  className={`palette__subhit${isSel ? " palette__subhit--selected" : ""}`}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setSelectedIndex(myIndex)}
                  onClick={() => void insertTemplate(entry.pasteText)}
                >
                  <span className="palette__subhit-title">{entry.title}</span>
                  <span className="palette__subhit-preview">{entry.preview}</span>
                </li>
              );
            })
          )
        ) : browseLength === 0 ? (
          <li className="palette__empty">Нет шаблонов</li>
        ) : (
          filteredBrowse.map((v, index) => {
            const id = visibleRowId(v);
            const pt = visiblePasteText(v);
            const hasBranch = visibleHasChildren(v);
            const inactive = !pt.trim() && !hasBranch;
            return (
              <li
                key={id}
                id={`snipcast-opt-${id}`}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                className={`palette__item palette__item--depth-0${
                  hasBranch ? " palette__item--branch" : ""
                }${index === selectedIndex ? " palette__item--selected" : ""}${
                  inactive ? " palette__item--inactive" : ""
                }`}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => {
                  if (hasBranch) {
                    setDrill((v as { kind: "top"; row: TemplateRow }).row);
                    setSelectedIndex(0);
                    return;
                  }
                  if (pt.trim()) void insertTemplate(pt);
                }}
              >
                <div className="palette__item-row">
                  {hasBranch ? <IconFolderOutline className="palette__folder-icon" /> : null}
                  <div className="palette__item-text">
                    <div className="palette__item-title">{visibleTitle(v)}</div>
                    <div className="palette__item-preview">{visiblePreview(v)}</div>
                  </div>
                  {hasBranch ? (
                    <span className="palette__chevron" aria-hidden>
                      ›
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>

      <footer className="palette__hints">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> навигация
        </span>
        <span>
          <kbd>Enter</kbd> вставить
        </span>
        <span>
          <kbd>Esc</kbd> {drill && !searching ? "назад" : "закрыть"}
        </span>
        <span className="palette__hints-muted">
          <kbd>{settingsKbd}</kbd> настройки
        </span>
      </footer>
    </div>
  );
}

export default App;
