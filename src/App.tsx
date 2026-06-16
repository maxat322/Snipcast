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
import { extractFileLinkRefs, stripFileLinkPlaceholders } from "./fileLinkPlaceholders";
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

function buildDrillStackFromFolderChain(row: TemplateRow, folderChain: TemplateChild[]): DrillFrame[] {
  if (!row.children?.length) return [];
  const frames: DrillFrame[] = [{ title: row.title, items: row.children }];
  for (const node of folderChain) {
    if (!node.children?.length) break;
    frames.push({ title: node.title, items: node.children });
  }
  return frames;
}

function folderSectionLabelPath(row: TemplateRow, folderChain: TemplateChild[]): string {
  const parts: string[] = [];
  if (row.title.trim()) parts.push(row.title);
  parts.push(...folderChain.map((n) => n.title));
  return parts.length > 0 ? parts.join(" • ") : row.id;
}

type GroupTab = {
  id: string;
  title: string;
  color: string;
};

type BracketPromptState = {
  baseText: string;
  labels: string[];
  values: Record<string, string>;
  fileRefs: string[];
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

/** Листья с цепочкой названий папок-предков (корень → родитель листа). */
function flattenLeavesWithPath(
  children: TemplateChild[],
  folderTrail: string[],
): Array<{ leaf: TemplateChild; folderTrail: string[] }> {
  const acc: Array<{ leaf: TemplateChild; folderTrail: string[] }> = [];
  for (const c of children) {
    if (c.isSeparator) continue;
    if (c.children && c.children.length > 0) {
      acc.push(...flattenLeavesWithPath(c.children, [...folderTrail, c.title]));
    } else {
      acc.push({ leaf: c, folderTrail });
    }
  }
  return acc;
}

function formatSearchHitTitle(leafTitle: string, folderTrail: string[]): string {
  if (folderTrail.length === 0) return leafTitle;
  return `${leafTitle} • ${folderTrail.join(" • ")}`;
}

/** Папка верхнего уровня (строка палитры с детьми): её заголовок — первый сегмент пути к листьям. */
function rowFolderPrefix(r: TemplateRow): string[] {
  if (!r.children?.length) return [];
  const t = r.title.trim();
  return t ? [t] : [];
}

type TierHit = {
  key: string;
  title: string;
  preview: string;
  pasteText: string;
};

type FolderSearchDisplayRow =
  | { kind: "subpunct"; sectionKey: string; labelPath: string; drillFrames: DrillFrame[] }
  | { kind: "hit"; hit: SearchHit };

/** Плоский порядок строк поиска для клавиатуры и aria-activedescendant. */
type SearchNavEntry =
  | { kind: "subpunct"; navKey: string; labelPath: string; drillFrames: DrillFrame[] }
  | { kind: "hit"; hit: SearchHit };

type SearchHitGroups = {
  /** Строки блока «по подпункту»: заголовок подпункта, затем его шаблоны. */
  folderDisplayRows: FolderSearchDisplayRow[];
  /** Совпадение по названию подпункта (папки) — для навигации и клавиатуры. */
  folderHits: SearchHit[];
  titleHits: SearchHit[];
  contentHits: SearchHit[];
};

function tierHitToSearchHit(h: TierHit): SearchHit | null {
  const pasteText = h.pasteText.trim();
  if (!pasteText) return null;
  return { key: h.key, title: h.title, preview: h.preview, pasteText };
}

function dedupeTierByKey(tiers: TierHit[]): TierHit[] {
  const seen = new Set<string>();
  const out: TierHit[] = [];
  for (const h of tiers) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    out.push(h);
  }
  return out;
}

function buildFolderDisplayRowsFromSections(
  sections: Array<{ sectionKey: string; labelPath: string; drillFrames: DrillFrame[]; hits: TierHit[] }>,
): FolderSearchDisplayRow[] {
  const rows: FolderSearchDisplayRow[] = [];
  const seenHitKeys = new Set<string>();
  for (const sec of sections) {
    const tierDeduped = dedupeTierByKey(sec.hits);
    const searchHits = tierDeduped.map(tierHitToSearchHit).filter((x): x is SearchHit => x !== null);
    const toShow = searchHits.filter((h) => !seenHitKeys.has(h.key));
    for (const h of searchHits) {
      seenHitKeys.add(h.key);
    }
    rows.push({
      kind: "subpunct",
      sectionKey: sec.sectionKey,
      labelPath: sec.labelPath,
      drillFrames: sec.drillFrames,
    });
    for (const h of toShow) {
      rows.push({ kind: "hit", hit: h });
    }
  }
  return rows;
}

/** Заголовки и содержимое раздельно; блок по подпункту с подписью найденной папки. */
function buildSearchHitGroups(rows: TemplateRow[], query: string): SearchHitGroups {
  const q = query.trim().toLowerCase();
  if (!q) {
    return { folderDisplayRows: [], folderHits: [], titleHits: [], contentHits: [] };
  }

  const folderSections: Array<{
    sectionKey: string;
    labelPath: string;
    drillFrames: DrillFrame[];
    hits: TierHit[];
  }> = [];
  const titleTier: TierHit[] = [];
  const bodyTier: TierHit[] = [];

  const pushTier = (arr: TierHit[], key: string, title: string, preview: string, pasteText: string) => {
    arr.push({ key, title, preview, pasteText });
  };

  function addAllLeavesFromPath(
    arr: TierHit[],
    children: TemplateChild[],
    rowId: string,
    pathPrefix: string[],
  ) {
    for (const { leaf, folderTrail } of flattenLeavesWithPath(children, pathPrefix)) {
      if (leaf.isSeparator) continue;
      const displayTitle = formatSearchHitTitle(leaf.title, folderTrail);
      pushTier(arr, `hit-${rowId}-${leaf.id}`, displayTitle, leaf.preview, getPasteText(leaf));
    }
  }

  /** Вложенные папки (TemplateChild): имя совпало — секция с подписью и переходом в подпункт. */
  function walkChildFoldersForNameMatch(
    children: TemplateChild[],
    row: TemplateRow,
    ancestorFolderChain: TemplateChild[],
  ) {
    const baseTrail = rowFolderPrefix(row);
    for (const c of children) {
      if (c.isSeparator) continue;
      if (!c.children?.length) continue;
      const chain = [...ancestorFolderChain, c];
      if (c.title.toLowerCase().includes(q)) {
        const hits: TierHit[] = [];
        const trailToC = [...baseTrail, ...ancestorFolderChain.map((n) => n.title), c.title];
        addAllLeavesFromPath(hits, c.children, row.id, trailToC);
        folderSections.push({
          sectionKey: `${row.id}::child::${c.id}`,
          labelPath: folderSectionLabelPath(row, chain),
          drillFrames: buildDrillStackFromFolderChain(row, chain),
          hits,
        });
      }
      walkChildFoldersForNameMatch(c.children, row, chain);
    }
  }

  function walkLeavesForSearch(children: TemplateChild[], rowId: string, folderTrail: string[]) {
    for (const c of children) {
      if (c.isSeparator) continue;
      if (c.children && c.children.length > 0) {
        walkLeavesForSearch(c.children, rowId, [...folderTrail, c.title]);
      } else {
        const displayTitle = formatSearchHitTitle(c.title, folderTrail);
        const t = c.title.toLowerCase().includes(q);
        const prev = c.preview.toLowerCase().includes(q);
        const body = c.pasteText.toLowerCase().includes(q);
        const pt = getPasteText(c);
        if (t) {
          pushTier(titleTier, `hit-${rowId}-${c.id}`, displayTitle, c.preview, pt);
        } else if (prev || body) {
          pushTier(bodyTier, `hit-${rowId}-${c.id}`, displayTitle, c.preview, pt);
        }
      }
    }
  }

  for (const r of rows) {
    if (r.isSeparator) continue;
    const hasKids = !!(r.children && r.children.length > 0);
    const parentPaste = (r.pasteText ?? "").trim();
    const baseTrail = rowFolderPrefix(r);

    if (hasKids) {
      const rowTitleMatch = r.title.toLowerCase().includes(q);
      if (rowTitleMatch) {
        const hits: TierHit[] = [];
        addAllLeavesFromPath(hits, r.children!, r.id, baseTrail);
        const drillFrames: DrillFrame[] = [{ title: r.title, items: r.children! }];
        folderSections.push({
          sectionKey: `${r.id}::row`,
          labelPath: r.title.trim() ? r.title : r.id,
          drillFrames,
          hits,
        });
      } else {
        walkChildFoldersForNameMatch(r.children!, r, []);
        walkLeavesForSearch(r.children!, r.id, baseTrail);
      }
    } else {
      const displayTitle = r.title;
      const t = r.title.toLowerCase().includes(q);
      const prev = r.preview.toLowerCase().includes(q);
      const body = parentPaste.toLowerCase().includes(q);
      const paste = r.pasteText ?? "";
      if (t) {
        pushTier(titleTier, `hit-${r.id}-leaf`, displayTitle, r.preview, paste);
      } else if (prev || body) {
        pushTier(bodyTier, `hit-${r.id}-leaf`, displayTitle, r.preview, paste);
      }
    }
  }

  const folderTierFlat = folderSections.flatMap((s) => s.hits);
  const folderTierDeduped = dedupeTierByKey(folderTierFlat);
  const folderKeys = new Set(folderTierDeduped.map((h) => h.key));

  const titleFiltered = titleTier.filter((h) => !folderKeys.has(h.key));
  const titleKeys = new Set([...folderKeys, ...titleFiltered.map((h) => h.key)]);
  const bodyFiltered = bodyTier.filter((h) => !titleKeys.has(h.key));

  const folderHits = folderTierDeduped.map(tierHitToSearchHit).filter((x): x is SearchHit => x !== null);
  const folderDisplayRows = buildFolderDisplayRowsFromSections(folderSections);
  const titleHits = titleFiltered.map(tierHitToSearchHit).filter((x): x is SearchHit => x !== null);
  const contentHits = bodyFiltered.map(tierHitToSearchHit).filter((x): x is SearchHit => x !== null);

  return { folderDisplayRows, folderHits, titleHits, contentHits };
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
  const queryRef = useRef(query);
  queryRef.current = query;
  const [selectedIndex, setSelectedIndex] = useState(0);
  /** Подсветка строки под курсором (светлее, чем клавиатурный фокус); не синхронизируется со стрелками. */
  const [hoverHighlightIndex, setHoverHighlightIndex] = useState<number | null>(null);
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
  const searchHitGroups = useMemo(
    () => buildSearchHitGroups(templatesByGroup, query),
    [templatesByGroup, query],
  );
  const searchNavEntries = useMemo((): SearchNavEntry[] => {
    const entries: SearchNavEntry[] = [];
    for (const r of searchHitGroups.folderDisplayRows) {
      if (r.kind === "subpunct") {
        entries.push({
          kind: "subpunct",
          navKey: `subpunct-${r.sectionKey}`,
          labelPath: r.labelPath,
          drillFrames: r.drillFrames,
        });
      } else {
        entries.push({ kind: "hit", hit: r.hit });
      }
    }
    for (const h of searchHitGroups.titleHits) {
      entries.push({ kind: "hit", hit: h });
    }
    for (const h of searchHitGroups.contentHits) {
      entries.push({ kind: "hit", hit: h });
    }
    return entries;
  }, [searchHitGroups]);

  const searchNavEntriesRef = useRef<SearchNavEntry[]>(searchNavEntries);
  searchNavEntriesRef.current = searchNavEntries;

  const filteredBrowse = useMemo(
    () => browseRows(templatesByGroup, searching ? [] : drillStack),
    [templatesByGroup, drillStack, searching],
  );

  const filteredBrowseRef = useRef(filteredBrowse);
  filteredBrowseRef.current = filteredBrowse;

  const activeList: "search" | "browse" = searching ? "search" : "browse";
  const browseLength = filteredBrowse.length;
  const searchNavLength = searchNavEntries.length;

  selectedIndexRef.current = selectedIndex;

  /**
   * После показа окна WebView часто шлёт mousemove/mouseenter «под курсором» без движения мыши.
   * Игнорируем наведение до этого момента (мс с epoch). Клик по строке обрабатывается через onPointerDown.
   */
  const paletteHoverIgnoreUntilRef = useRef(0);

  const armPaletteHoverIgnore = useCallback((msFromNow = 420) => {
    paletteHoverIgnoreUntilRef.current = Date.now() + msFromNow;
  }, []);

  const onListMouseEnter = useCallback((index: number) => {
    if (Date.now() < paletteHoverIgnoreUntilRef.current) return;
    setHoverHighlightIndex(index);
  }, []);

  const onListPointerDownSelect = useCallback((index: number) => {
    setSelectedIndex(index);
    setHoverHighlightIndex(index);
  }, []);

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

  const pasteContent = useCallback(async (text: string, fileRefs: string[]) => {
    const body = text.trim();
    const refs = fileRefs.map((r) => r.trim()).filter(Boolean);
    if (!body && refs.length === 0) return;
    try {
      if (refs.length > 0) {
        await invoke("paste_template_text_then_files", {
          text: body,
          fileRefs: refs,
          delayMs: 100,
        });
      } else {
        await invoke("paste_template", { text: body });
      }
    } catch {
      /* см. README: macOS — доступ */
    }
  }, []);

  const startInsert = useCallback(
    (raw: string) => {
      const afterVars = substituteVars(raw);
      const fileRefs = extractFileLinkRefs(afterVars);
      const bodyText = stripFileLinkPlaceholders(afterVars);
      const labels = extractOrderedBracketLabels(bodyText);
      if (labels.length === 0) {
        void pasteContent(bodyText, fileRefs);
        return;
      }
      const values: Record<string, string> = {};
      for (const lab of labels) values[lab] = "";
      setBracketPrompt({ baseText: bodyText, labels, values, fileRefs });
    },
    [substituteVars, pasteContent],
  );

  const collectBracketValuesFromForm = useCallback((form: HTMLFormElement): Record<string, string> => {
    const prev = bracketPromptRef.current;
    const base = prev ? { ...prev.values } : {};
    for (const inp of form.querySelectorAll<HTMLInputElement>("[data-bracket-label]")) {
      const lab = inp.dataset.bracketLabel;
      if (lab) base[lab] = inp.value;
    }
    return base;
  }, []);

  const handleBracketFormKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLFormElement>) => {
      if (e.key !== "Enter") return;
      const prev = bracketPromptRef.current;
      if (!prev) return;

      e.preventDefault();
      e.stopPropagation();

      const form = e.currentTarget;

      if (e.metaKey || e.ctrlKey) {
        void (async () => {
          const p = bracketPromptRef.current;
          if (!p) return;
          const el = document.activeElement;
          if (!(el instanceof HTMLInputElement)) return;
          const activeLab = el.dataset.bracketLabel;
          if (!activeLab || !p.labels.includes(activeLab)) return;
          try {
            const clip = await invoke<string>("snipcast_clipboard_read_text");
            const values = collectBracketValuesFromForm(form);
            values[activeLab] = clip;
            const merged = applyBracketReplacements(p.baseText, p.labels, values);
            setBracketPrompt(null);
            await pasteContent(merged, p.fileRefs);
          } catch {
            /* буфер или вставка в целевое приложение */
          }
        })();
        return;
      }

      const values = collectBracketValuesFromForm(form);
      const merged = applyBracketReplacements(prev.baseText, prev.labels, values);
      setBracketPrompt(null);
      void pasteContent(merged, prev.fileRefs);
    },
    [pasteContent, collectBracketValuesFromForm],
  );

  useEffect(() => {
    void reloadData();
  }, [reloadData]);

  /** Палитра живёт в скрытом окне: при каждом показе подтягиваем шаблоны с диска (настройки, мастер-папка). */
  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = getCurrentWindow().listen("tauri://focus", () => {
      armPaletteHoverIgnore();
      if (!cancelled) void reloadData();
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((fn) => fn());
    };
  }, [reloadData, armPaletteHoverIgnore]);

  const navLength = activeList === "search" ? searchNavLength : browseLength;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, drillStack, searching, navLength]);

  useEffect(() => {
    setHoverHighlightIndex(null);
  }, [query, drillStack, searching, activeGroupId]);

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
  }, [selectedIndex, activeList, searchNavEntries, filteredBrowse]);

  useEffect(() => {
    let unlistenFocus: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (focused) {
            armPaletteHoverIgnore();
            setBracketPrompt(null);
            setQuery("");
            setDrillStack([]);
            setSelectedIndex(0);
            setHoverHighlightIndex(null);
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
  }, [reloadData, armPaletteHoverIgnore]);

  useEffect(() => {
    armPaletteHoverIgnore();
  }, [armPaletteHoverIgnore]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        armPaletteHoverIgnore();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [armPaletteHoverIgnore]);

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
        if (drillStack.length > 0 && !queryRef.current.trim()) {
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

      const isSearchMode = queryRef.current.trim().length > 0;
      const effectiveNavLen = isSearchMode ? searchNavEntriesRef.current.length : filteredBrowseRef.current.length;
      if (effectiveNavLen === 0) return;

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
        if (!isSearchMode && filteredBrowseRef.current.length > 0) {
          setSelectedIndex((i) => nextNonSeparatorBrowseIndex(filteredBrowseRef.current, i, 1));
        } else if (isSearchMode && searchNavEntriesRef.current.length > 0) {
          const slen = searchNavEntriesRef.current.length;
          setSelectedIndex((i) => (i + 1) % slen);
        }
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!isSearchMode && filteredBrowseRef.current.length > 0) {
          setSelectedIndex((i) => nextNonSeparatorBrowseIndex(filteredBrowseRef.current, i, -1));
        } else if (isSearchMode && searchNavEntriesRef.current.length > 0) {
          const slen = searchNavEntriesRef.current.length;
          setSelectedIndex((i) => (i - 1 + slen) % slen);
        }
        return;
      }

      if (e.key === "Tab" && !queryRef.current.trim()) {
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

      if (e.key === "ArrowLeft" && !queryRef.current.trim() && drillStack.length > 0) {
        e.preventDefault();
        setDrillStack((s) => s.slice(0, -1));
        setSelectedIndex(0);
        return;
      }

      if (e.key === "Backspace" && !queryRef.current.trim() && drillStack.length > 0 && !inSearch) {
        e.preventDefault();
        setDrillStack((s) => s.slice(0, -1));
        setSelectedIndex(0);
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const idx = selectedIndexRef.current;
        const searchMode = queryRef.current.trim().length > 0;
        if (searchMode) {
          const entry = searchNavEntriesRef.current[idx];
          if (!entry) return;
          if (entry.kind === "subpunct") {
            const frames = entry.drillFrames;
            if (!frames.length) return;
            setDrillStack(frames);
            setQuery("");
            setSelectedIndex(0);
            queueMicrotask(() => {
              searchRef.current?.focus();
              searchRef.current?.select();
            });
            return;
          }
          startInsert(entry.hit.pasteText);
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
  }, [navLength, hide, startInsert, openSettings, groupIds, groupTabIndex, filteredBrowse, drillStack]);

  const activeSearchEntry = searching ? searchNavEntries[selectedIndex] : undefined;
  const activeDescendantId =
    navLength > 0
      ? activeList === "search" && activeSearchEntry
        ? activeSearchEntry.kind === "subpunct"
          ? `snipcast-${activeSearchEntry.navKey}`
          : `snipcast-hit-${activeSearchEntry.hit.key}`
        : `snipcast-opt-${visibleRowId(filteredBrowse[selectedIndex] as VisibleRow)}`
      : undefined;

  return (
    <div className="palette" data-tauri-drag-region onContextMenu={(e) => e.preventDefault()}>
      <header className="palette__chrome">
        {drillStack.length > 0 && !searching ? (
          <div className="palette__breadcrumb">
            <button
              type="button"
              className="palette__back"
              data-tauri-drag-region="false"
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
            data-tauri-drag-region="false"
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
            data-tauri-drag-region="false"
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
              data-tauri-drag-region="false"
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
        onMouseLeave={() => setHoverHighlightIndex(null)}
      >
        {activeList === "search" ? (
          searchNavLength === 0 ? (
            <li className="palette__empty">Нет совпадений</li>
          ) : (
            <>
              {(() => {
                const folderNavCount = searchHitGroups.folderDisplayRows.length;
                const tLen = searchHitGroups.titleHits.length;
                const cLen = searchHitGroups.contentHits.length;
                const showSepBeforeTitle = folderNavCount > 0 && tLen > 0;
                const showContentHeader = cLen > 0 && (folderNavCount > 0 || tLen > 0);

                const renderHit = (hit: SearchHit, myIndex: number) => {
                  const isKb = myIndex === selectedIndex;
                  const isCursor = myIndex === hoverHighlightIndex;
                  const rowClass =
                    `palette__subhit${isKb ? " palette__subhit--kb" : ""}${isCursor ? " palette__subhit--cursor" : ""}`;
                  return (
                    <li
                      key={hit.key}
                      id={`snipcast-hit-${hit.key}`}
                      ref={(el) => {
                        itemRefs.current[myIndex] = el;
                      }}
                      className={rowClass}
                      role="option"
                      aria-selected={isKb}
                      data-tauri-drag-region="false"
                      onPointerDown={(e) => {
                        if (e.button === 0) onListPointerDownSelect(myIndex);
                      }}
                      onMouseEnter={() => onListMouseEnter(myIndex)}
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
                };

                let navIdx = 0;
                return (
                  <>
                    {searchHitGroups.folderDisplayRows.map((row) => {
                      if (row.kind === "subpunct") {
                        const myIndex = navIdx++;
                        const isKb = myIndex === selectedIndex;
                        const isCursor = myIndex === hoverHighlightIndex;
                        const rowClass =
                          `palette__search-subpunct${isKb ? " palette__search-subpunct--kb" : ""}${isCursor ? " palette__search-subpunct--cursor" : ""}`;
                        return (
                          <li
                            key={row.sectionKey}
                            id={`snipcast-subpunct-${row.sectionKey}`}
                            ref={(el) => {
                              itemRefs.current[myIndex] = el;
                            }}
                            className={rowClass}
                            role="option"
                            aria-selected={isKb}
                            aria-label={`Папка ${row.labelPath}`}
                            data-tauri-drag-region="false"
                            onPointerDown={(e) => {
                              if (e.button === 0) onListPointerDownSelect(myIndex);
                            }}
                            onMouseEnter={() => onListMouseEnter(myIndex)}
                            onClick={() => {
                              const frames = row.drillFrames;
                              if (!frames.length) return;
                              setDrillStack(frames);
                              setQuery("");
                              setSelectedIndex(0);
                              setHoverHighlightIndex(null);
                              queueMicrotask(() => {
                                searchRef.current?.focus();
                                searchRef.current?.select();
                              });
                            }}
                          >
                            <div className="palette__item-row">
                              <IconFolderOutline className="palette__folder-icon" />
                              <span className="palette__search-subpunct-path">
                                {highlightText(row.labelPath, query)}
                              </span>
                            </div>
                          </li>
                        );
                      }
                      const myIndex = navIdx++;
                      return renderHit(row.hit, myIndex);
                    })}
                    {showSepBeforeTitle ? <li className="palette__search-sep" aria-hidden /> : null}
                    {searchHitGroups.titleHits.map((hit, i) => renderHit(hit, folderNavCount + i))}
                    {showContentHeader ? (
                      <>
                        <li className="palette__search-sep" aria-hidden />
                        <li className="palette__search-heading">
                          <span>По содержимому</span>
                        </li>
                      </>
                    ) : null}
                    {searchHitGroups.contentHits.map((hit, i) =>
                      renderHit(hit, folderNavCount + tLen + i),
                    )}
                  </>
                );
              })()}
            </>
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
            const isKb = index === selectedIndex;
            const isCursor = index === hoverHighlightIndex;
            const rowClass =
              `palette__item ${browseRowDepthClass(v, drillStack.length)}${
                hasBranch ? " palette__item--branch" : ""
              }${isKb ? " palette__item--kb" : ""}${isCursor ? " palette__item--cursor" : ""}${
                inactive ? " palette__item--inactive" : ""
              }`;
            return (
              <li
                key={id}
                id={`snipcast-opt-${id}`}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                className={rowClass}
                role="option"
                aria-selected={isKb}
                data-tauri-drag-region="false"
                onPointerDown={(e) => {
                  if (e.button === 0) onListPointerDownSelect(index);
                }}
                onMouseEnter={() => onListMouseEnter(index)}
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
                    {hasBranch ? null : <div className="palette__item-preview">{visiblePreview(v)}</div>}
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
          data-tauri-drag-region="false"
          onClick={(e) => {
            if (e.target === e.currentTarget) setBracketPrompt(null);
          }}
        >
          <div
            className="palette__modal palette__modal--bracket"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bracket-modal-title"
            data-tauri-drag-region="false"
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
                void pasteContent(merged, p.fileRefs);
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
                    data-tauri-drag-region="false"
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
