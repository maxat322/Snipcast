import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyBracketReplacements, extractOrderedBracketLabels } from "./bracketPlaceholders";
import type { AppConfig, TemplateChild, TemplateRow } from "./types";
import {
  applyPaletteListDensity,
  applyUiThemeSetting,
  normalizePaletteListDensity,
  normalizeUiTheme,
} from "./uiTheme";
import "./theme-overrides.css";
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

/**
 * Уникальные корневые шаблоны по id. При совпадении id оставляем последний вариант
 * (обычно «Свои» идут после мастера и должны перекрывать дубликат).
 */
function dedupeTemplatesById(rows: TemplateRow[]): TemplateRow[] {
  const lastIndex = new Map<string, number>();
  rows.forEach((r, i) => lastIndex.set(r.id, i));
  return rows.filter((r, i) => lastIndex.get(r.id) === i);
}

type SearchHit = {
  key: string;
  title: string;
  preview: string;
  pasteText: string;
};

/** Кадр навигации внутри вложенных подпунктов */
type DrillFrame = {
  title: string;
  items: TemplateChild[];
};

type GroupTab = {
  id: string;
  title: string;
  color: string;
};

type BracketPromptState = {
  baseText: string;
  labels: string[];
  values: Record<string, string>;
};

type VisibleRow =
  | { kind: "top"; row: TemplateRow }
  | { kind: "nested"; child: TemplateChild; pathKey: string };

function visibleIsSeparator(v: VisibleRow): boolean {
  if (v.kind === "top") return !!v.row.isSeparator;
  return !!v.child.isSeparator;
}

/** Подсветка всех вхождений запроса (без учёта регистра). */
function highlightText(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const ql = q.toLowerCase();
  const nodes: ReactNode[] = [];
  let i = 0;
  let mk = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const rel = rest.toLowerCase().indexOf(ql);
    if (rel < 0) {
      nodes.push(rest);
      break;
    }
    if (rel > 0) nodes.push(text.slice(i, i + rel));
    const end = i + rel + q.length;
    nodes.push(
      <mark key={`hm-${mk++}`} className="palette__hit-mark">
        {text.slice(i + rel, end)}
      </mark>,
    );
    i = end;
  }
  return <>{nodes}</>;
}

function getPasteText(row: TemplateRow | TemplateChild): string {
  if ("children" in row && row.children && row.children.length > 0) {
    return row.pasteText ?? "";
  }
  if ("pasteText" in row && row.pasteText !== undefined) {
    return row.pasteText;
  }
  return "";
}

function flattenLeafTemplates(children: TemplateChild[]): TemplateChild[] {
  const acc: TemplateChild[] = [];
  for (const c of children) {
    if (c.isSeparator) continue;
    if (c.children && c.children.length > 0) {
      acc.push(...flattenLeafTemplates(c.children));
    } else {
      acc.push(c);
    }
  }
  return acc;
}

type TierHit = {
  key: string;
  title: string;
  preview: string;
  pasteText: string;
};

/** Результаты поиска: сначала совпадения по заголовкам, затем по тексту шаблона (без заголовков секций). */
function buildSearchHits(rows: TemplateRow[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const out: SearchHit[] = [];
  const usedHitKeys = new Set<string>();

  const pushHit = (key: string, title: string, preview: string, pasteText: string) => {
    const pt = pasteText.trim();
    if (!pt || usedHitKeys.has(key)) return;
    usedHitKeys.add(key);
    out.push({ key, title, preview, pasteText: pt });
  };

  const titleTier: TierHit[] = [];
  const bodyTier: TierHit[] = [];

  const pushTier = (arr: TierHit[], key: string, title: string, preview: string, pasteText: string) => {
    arr.push({ key, title, preview, pasteText });
  };

  function walkLeavesForSearch(children: TemplateChild[], rowId: string) {
    for (const c of children) {
      if (c.isSeparator) continue;
      if (c.children && c.children.length > 0) {
        walkLeavesForSearch(c.children, rowId);
      } else {
        const t = c.title.toLowerCase().includes(q);
        const prev = c.preview.toLowerCase().includes(q);
        const body = c.pasteText.toLowerCase().includes(q);
        const pt = getPasteText(c);
        if (t) {
          pushTier(titleTier, `hit-${rowId}-${c.id}`, c.title, c.preview, pt);
        } else if (prev || body) {
          pushTier(bodyTier, `hit-${rowId}-${c.id}`, c.title, c.preview, pt);
        }
      }
    }
  }

  for (const r of rows) {
    if (r.isSeparator) continue;
    const hasKids = !!(r.children && r.children.length > 0);
    const parentPaste = (r.pasteText ?? "").trim();

    if (hasKids) {
      if (r.title.toLowerCase().includes(q)) {
        for (const leaf of flattenLeafTemplates(r.children!)) {
          if (leaf.isSeparator) continue;
          pushTier(
            titleTier,
            `hit-${r.id}-${leaf.id}`,
            leaf.title,
            leaf.preview,
            getPasteText(leaf),
          );
        }
      } else {
        walkLeavesForSearch(r.children!, r.id);
      }
    } else {
      const t = r.title.toLowerCase().includes(q);
      const prev = r.preview.toLowerCase().includes(q);
      const body = parentPaste.toLowerCase().includes(q);
      const paste = r.pasteText ?? "";
      if (t) {
        pushTier(titleTier, `hit-${r.id}-leaf`, r.title, r.preview, paste);
      } else if (prev || body) {
        pushTier(bodyTier, `hit-${r.id}-leaf`, r.title, r.preview, paste);
      }
    }
  }

  const titleKeys = new Set(titleTier.map((h) => h.key));
  const bodyFiltered = bodyTier.filter((h) => !titleKeys.has(h.key));

  for (const h of titleTier) {
    pushHit(h.key, h.title, h.preview, h.pasteText);
  }
  for (const h of bodyFiltered) {
    pushHit(h.key, h.title, h.preview, h.pasteText);
  }

  return out;
}

function browseRows(templates: TemplateRow[], stack: DrillFrame[]): VisibleRow[] {
  if (stack.length === 0) {
    return templates.map((row) => ({ kind: "top" as const, row }));
  }
  const frame = stack[stack.length - 1]!;
  const pathKey = stack.map((f) => f.title).join("::");
  return frame.items.map((child) => ({ kind: "nested" as const, child, pathKey }));
}

function visibleRowId(v: VisibleRow): string {
  if (v.kind === "top") return `t-${v.row.id}`;
  const safe = v.pathKey.replace(/\s+/g, "_");
  return `n-${safe}-${v.child.id}`;
}

function visiblePasteText(v: VisibleRow): string {
  if (v.kind === "top") return getPasteText(v.row);
  return getPasteText(v.child);
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
  if (v.kind === "top") {
    return (
      !v.row.isSeparator && !!(v.row.children && v.row.children.length > 0)
    );
  }
  return (
    !v.child.isSeparator &&
    !!(v.child.children && v.child.children.length > 0)
  );
}

function nextNonSeparatorBrowseIndex(
  list: VisibleRow[],
  from: number,
  delta: 1 | -1,
): number {
  const len = list.length;
  if (len === 0) return 0;
  let i = from;
  for (let s = 0; s < len; s++) {
    i = (i + delta + len) % len;
    if (!visibleIsSeparator(list[i]!)) return i;
  }
  return from;
}

function browseRowDepthClass(v: VisibleRow, drillDepth: number): string {
  if (v.kind === "top") return "palette__item--depth-0";
  return drillDepth > 1 ? "palette__item--depth-2" : "palette__item--depth-1";
}

function App() {
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const selectedIndexRef = useRef(0);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [varMap, setVarMap] = useState<Record<string, string>>({});
  const [drillStack, setDrillStack] = useState<DrillFrame[]>([]);
  const [activeGroupId, setActiveGroupId] = useState("all");
  const [groupTabIndex, setGroupTabIndex] = useState(0);
  const [bracketPrompt, setBracketPrompt] = useState<BracketPromptState | null>(null);
  const bracketPromptRef = useRef<BracketPromptState | null>(null);
  bracketPromptRef.current = bracketPrompt;
  const themeSettingRef = useRef(normalizeUiTheme(undefined));

  const uniqueTemplates = useMemo(() => dedupeTemplatesById(templates), [templates]);
  const groupTabs = useMemo<GroupTab[]>(() => {
    const byId = new Map<string, GroupTab>();
    for (const t of uniqueTemplates) {
      if (!t.groupId) continue;
      if (!byId.has(t.groupId)) {
        byId.set(t.groupId, {
          id: t.groupId,
          title: t.groupTitle || "Группа",
          color: t.groupColor || "#5164f2",
        });
      }
    }
    return Array.from(byId.values());
  }, [uniqueTemplates]);
  const groupIds = useMemo(() => ["all", ...groupTabs.map((g) => g.id)], [groupTabs]);
  const templatesByGroup = useMemo(
    () =>
      activeGroupId === "all"
        ? uniqueTemplates
        : uniqueTemplates.filter((t) => t.groupId === activeGroupId),
    [activeGroupId, uniqueTemplates],
  );
  const searching = query.trim().length > 0;
  const searchHits = useMemo(
    () => buildSearchHits(templatesByGroup, query),
    [templatesByGroup, query],
  );

  const filteredBrowse = useMemo(
    () => browseRows(templatesByGroup, searching ? [] : drillStack),
    [templatesByGroup, drillStack, searching],
  );

  const activeList: "search" | "browse" = searching ? "search" : "browse";
  const browseLength = filteredBrowse.length;
  const searchHitLength = searchHits.length;

  selectedIndexRef.current = selectedIndex;

  const reloadData = useCallback(async (opts?: { resetGroupFilter?: boolean }) => {
    try {
      const [rows, vars, cfg] = await Promise.all([
        invoke<TemplateRow[]>("snipcast_list_templates"),
        invoke<Record<string, unknown>>("snipcast_get_variables"),
        invoke<AppConfig>("snipcast_get_config"),
      ]);
      const theme = normalizeUiTheme(cfg.theme);
      const density = normalizePaletteListDensity(cfg.paletteListDensity);
      themeSettingRef.current = theme;
      applyUiThemeSetting(theme);
      applyPaletteListDensity(density);
      setTemplates(rows);
      if (opts?.resetGroupFilter) {
        setActiveGroupId("all");
      } else {
        setActiveGroupId((prev) => {
          if (prev === "all") return prev;
          return rows.some((r) => r.groupId === prev) ? prev : "all";
        });
      }
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) {
        m[k] = typeof v === "string" ? v : String(v);
      }
      setVarMap(m);
    } catch (e) {
      console.error("[Snipcast] не удалось загрузить шаблоны:", e);
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

  const pastePlainText = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    try {
      await invoke("paste_template", { text: t });
    } catch {
      /* см. README: macOS — доступ */
    }
  }, []);

  const startInsert = useCallback(
    (raw: string) => {
      const afterVars = substituteVars(raw);
      const labels = extractOrderedBracketLabels(afterVars);
      if (labels.length === 0) {
        void pastePlainText(afterVars);
        return;
      }
      const values: Record<string, string> = {};
      for (const lab of labels) values[lab] = "";
      setBracketPrompt({ baseText: afterVars, labels, values });
    },
    [substituteVars, pastePlainText],
  );

  const handleBracketFormKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLFormElement>) => {
      if (e.key !== "Enter" || (!e.metaKey && !e.ctrlKey)) return;
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        const prev = bracketPromptRef.current;
        if (!prev) return;
        const el = document.activeElement;
        if (!(el instanceof HTMLInputElement)) return;
        const lab = el.dataset.bracketLabel;
        if (!lab || !prev.labels.includes(lab)) return;
        try {
          const clip = await invoke<string>("snipcast_clipboard_read_text");
          const newValues = { ...prev.values, [lab]: clip };
          const merged = applyBracketReplacements(prev.baseText, prev.labels, newValues);
          setBracketPrompt(null);
          await pastePlainText(merged);
        } catch {
          /* буфер или вставка в целевое приложение */
        }
      })();
    },
    [pastePlainText],
  );

  useEffect(() => {
    void reloadData();
  }, [reloadData]);

  /** Палитра живёт в скрытом окне: при каждом показе подтягиваем шаблоны с диска (настройки, мастер-папка). */
  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = getCurrentWindow().listen("tauri://focus", () => {
      if (!cancelled) void reloadData();
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((fn) => fn());
    };
  }, [reloadData]);

  const navLength = activeList === "search" ? searchHitLength : browseLength;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, drillStack, searching, navLength]);

  useEffect(() => {
    const idx = groupIds.indexOf(activeGroupId);
    setGroupTabIndex(idx >= 0 ? idx : 0);
  }, [activeGroupId, groupIds]);

  useEffect(() => {
    if (searching || activeList !== "browse" || filteredBrowse.length === 0) return;
    setSelectedIndex((i) => {
      const v = filteredBrowse[i];
      if (v && !visibleIsSeparator(v)) return i;
      const j = filteredBrowse.findIndex((x) => !visibleIsSeparator(x));
      return j >= 0 ? j : 0;
    });
  }, [searching, activeList, filteredBrowse]);

  useEffect(() => {
    if (navLength === 0) return;
    setSelectedIndex((i) => Math.min(i, navLength - 1));
  }, [navLength]);

  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIndex, activeList, searchHits, filteredBrowse]);

  useEffect(() => {
    let unlistenFocus: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (focused) {
            setBracketPrompt(null);
            setQuery("");
            setDrillStack([]);
            setSelectedIndex(0);
            void reloadData({ resetGroupFilter: true });
            queueMicrotask(() => {
              searchRef.current?.focus();
              searchRef.current?.select();
            });
          }
        })
        .then((fn) => {
          unlistenFocus = fn;
        })
        .catch(() => {
          /* нет window API — палитра всё равно работает без авто-обновления по фокусу */
        });
    } catch {
      /* getCurrentWindow() недоступен до инжекта Tauri */
    }

    return () => {
      unlistenFocus?.();
    };
  }, [reloadData]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      if (themeSettingRef.current === "system") {
        applyUiThemeSetting("system");
      }
    };
    mq.addEventListener("change", onScheme);
    return () => mq.removeEventListener("change", onScheme);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const bp = bracketPromptRef.current;
      if (bp) {
        if (e.key === "Escape") {
          e.preventDefault();
          setBracketPrompt(null);
          return;
        }
        const el = e.target as HTMLElement | null;
        if (el?.closest?.(".palette__modal")) return;
        e.preventDefault();
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (drillStack.length > 0 && !searching) {
          setDrillStack((s) => s.slice(0, -1));
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
        if (drillStack.length > 0) {
          e.preventDefault();
          setDrillStack([]);
          setSelectedIndex(0);
          return;
        }
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (activeList === "browse" && filteredBrowse.length > 0) {
          setSelectedIndex((i) => nextNonSeparatorBrowseIndex(filteredBrowse, i, 1));
        } else {
          setSelectedIndex((i) => (i + 1) % navLength);
        }
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (activeList === "browse" && filteredBrowse.length > 0) {
          setSelectedIndex((i) => nextNonSeparatorBrowseIndex(filteredBrowse, i, -1));
        } else {
          setSelectedIndex((i) => (i - 1 + navLength) % navLength);
        }
        return;
      }

      if (e.key === "Tab" && !searching) {
        e.preventDefault();
        if (groupIds.length <= 1) return;
        const next = e.shiftKey
          ? (groupTabIndex - 1 + groupIds.length) % groupIds.length
          : (groupTabIndex + 1) % groupIds.length;
        setGroupTabIndex(next);
        setActiveGroupId(groupIds[next]!);
        setDrillStack([]);
        setSelectedIndex(0);
        return;
      }

      if (e.key === "ArrowLeft" && !searching && drillStack.length > 0) {
        e.preventDefault();
        setDrillStack((s) => s.slice(0, -1));
        setSelectedIndex(0);
        return;
      }

      if (e.key === "Backspace" && !searching && drillStack.length > 0 && !inSearch) {
        e.preventDefault();
        setDrillStack((s) => s.slice(0, -1));
        setSelectedIndex(0);
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const idx = selectedIndexRef.current;
        if (activeList === "search") {
          const hit = searchHits[idx];
          if (hit) startInsert(hit.pasteText);
          return;
        }
        const v = filteredBrowse[idx] as VisibleRow | undefined;
        if (!v) return;
        if (visibleIsSeparator(v)) return;
        if (visibleHasChildren(v)) {
          if (v.kind === "top") {
            const row = v.row;
            if (row.children?.length) {
              setDrillStack([{ title: row.title, items: row.children }]);
            }
          } else {
            const ch = v.child;
            if (ch.children?.length) {
              setDrillStack((s) => [...s, { title: ch.title, items: ch.children! }]);
            }
          }
          setSelectedIndex(0);
          return;
        }
        const pt = visiblePasteText(v);
        if (pt.trim()) startInsert(pt);
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    navLength,
    hide,
    startInsert,
    openSettings,
    groupIds,
    groupTabIndex,
    activeList,
    searchHits,
    filteredBrowse,
    searching,
    drillStack,
  ]);

  const activeHit = searching ? searchHits[selectedIndex] : undefined;
  const activeDescendantId =
    navLength > 0
      ? activeList === "search" && activeHit
        ? `snipcast-hit-${activeHit.key}`
        : `snipcast-opt-${visibleRowId(filteredBrowse[selectedIndex] as VisibleRow)}`
      : undefined;

  return (
    <div className="palette">
      <header className="palette__chrome" data-tauri-drag-region>
        {drillStack.length > 0 && !searching ? (
          <div className="palette__breadcrumb">
            <button
              type="button"
              className="palette__back"
              onClick={() => {
                setDrillStack((s) => s.slice(0, -1));
                setSelectedIndex(0);
              }}
            >
              ← {drillStack.map((f) => f.title).join(" › ")}
            </button>
          </div>
        ) : null}
        <div className="palette__search-wrap">
          <span className="palette__search-icon" aria-hidden>
            🔎
          </span>
          <input
            ref={searchRef}
            className="palette__search"
            type="text"
            placeholder="Поиск по шаблонам..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setDrillStack([]);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-controls="snipcast-listbox"
            aria-activedescendant={activeDescendantId}
          />
        </div>
        <div className="palette__group-tabs" role="tablist" aria-label="Группы">
          <button
            type="button"
            role="tab"
            aria-selected={activeGroupId === "all"}
            className={`palette__group-tab${activeGroupId === "all" ? " is-active" : ""}`}
            onClick={() => {
              setActiveGroupId("all");
              setDrillStack([]);
              setSelectedIndex(0);
            }}
          >
            Все
          </button>
          {groupTabs.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={activeGroupId === g.id}
              className={`palette__group-tab${activeGroupId === g.id ? " is-active" : ""}`}
              style={{ "--group-color": g.color } as React.CSSProperties}
              onClick={() => {
                setActiveGroupId(g.id);
                setDrillStack([]);
                setSelectedIndex(0);
              }}
            >
              {g.title}
            </button>
          ))}
        </div>
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
            searchHits.map((hit, myIndex) => {
              const isSel = myIndex === selectedIndex;
              return (
                <li
                  key={hit.key}
                  id={`snipcast-hit-${hit.key}`}
                  ref={(el) => {
                    itemRefs.current[myIndex] = el;
                  }}
                  className={`palette__subhit${isSel ? " palette__subhit--selected" : ""}`}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setSelectedIndex(myIndex)}
                  onClick={() => startInsert(hit.pasteText)}
                >
                  <span className="palette__subhit-title">
                    {highlightText(hit.title, query)}
                  </span>
                  <span className="palette__subhit-preview">
                    {highlightText(hit.preview, query)}
                  </span>
                </li>
              );
            })
          )
        ) : browseLength === 0 ? (
          <li className="palette__empty">Нет шаблонов</li>
        ) : (
          filteredBrowse.map((v, index) => {
            const id = visibleRowId(v);
            if (visibleIsSeparator(v)) {
              return (
                <li
                  key={id}
                  id={`snipcast-opt-${id}`}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  className="palette__sep"
                  role="separator"
                  aria-hidden
                />
              );
            }
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
                className={`palette__item ${browseRowDepthClass(v, drillStack.length)}${
                  hasBranch ? " palette__item--branch" : ""
                }${
                  index === selectedIndex ? " palette__item--selected" : ""
                }${inactive ? " palette__item--inactive" : ""}`}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => {
                  if (hasBranch) {
                    if (v.kind === "top") {
                      const row = v.row;
                      if (row.children?.length) {
                        setDrillStack([{ title: row.title, items: row.children }]);
                      }
                    } else {
                      const ch = v.child;
                      if (ch.children?.length) {
                        setDrillStack((s) => [...s, { title: ch.title, items: ch.children! }]);
                      }
                    }
                    setSelectedIndex(0);
                    return;
                  }
                  if (pt.trim()) startInsert(pt);
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
          навигация <kbd>↑</kbd> <kbd>↓</kbd>
        </span>
        <span>
          вставить <kbd>Enter</kbd>
        </span>
        <span>
          {drillStack.length > 0 && !searching ? "назад" : "закрыть"} <kbd>Esc</kbd>
        </span>
        <span>
          группы <kbd>Tab</kbd>
        </span>
        <span className="palette__hints-muted palette__hints-settings">
          настройки
          {/Mac|iPhone|iPad/.test(navigator.userAgent) ? (
            <>
              <kbd>⌘</kbd>
              <kbd>K</kbd>
            </>
          ) : (
            <>
              <kbd>Ctrl</kbd>
              <kbd>K</kbd>
            </>
          )}
        </span>
      </footer>

      {bracketPrompt ? (
        <div
          className="palette__modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setBracketPrompt(null);
          }}
        >
          <div
            className="palette__modal palette__modal--bracket"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bracket-modal-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <header className="palette__modal-chrome">
              <h3 id="bracket-modal-title" className="palette__modal-title">
                Ввод шаблона
              </h3>
            </header>
            <form
              className="palette__modal-body"
              onSubmit={(e) => {
                e.preventDefault();
                const p = bracketPrompt;
                if (!p) return;
                const merged = applyBracketReplacements(p.baseText, p.labels, p.values);
                setBracketPrompt(null);
                void pastePlainText(merged);
              }}
              onKeyDown={handleBracketFormKeyDown}
            >
              <div className="palette__modal-fields">
                {bracketPrompt.labels.map((label, i) => (
                  <input
                    key={label}
                    id={`bracket-in-${i}`}
                    className="palette__modal-input-bare"
                    type="text"
                    data-bracket-label={label}
                    value={bracketPrompt.values[label] ?? ""}
                    onChange={(ev) =>
                      setBracketPrompt((prev) =>
                        prev
                          ? { ...prev, values: { ...prev.values, [label]: ev.target.value } }
                          : prev,
                      )
                    }
                    placeholder={label}
                    autoFocus={i === 0}
                    autoComplete="off"
                    spellCheck={false}
                  />
                ))}
              </div>
              <p className="palette__modal-field-caption">Введите текст для поля</p>
              <footer className="palette__hints palette__modal-hints">
                <span>
                  отмена <kbd>Esc</kbd>
                </span>
                <span>
                  буфер и применить{" "}
                  {/Mac|iPhone|iPad/.test(navigator.userAgent) ? (
                    <>
                      <kbd>⌘</kbd>
                      <kbd>Enter</kbd>
                    </>
                  ) : (
                    <>
                      <kbd>Ctrl</kbd>
                      <kbd>Enter</kbd>
                    </>
                  )}
                </span>
                <span>
                  вставить <kbd>Enter</kbd>
                </span>
              </footer>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
