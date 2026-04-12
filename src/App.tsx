import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

type TemplateChild = {
  id: string;
  title: string;
  preview: string;
  pasteText: string;
};

type TemplateRow = {
  id: string;
  title: string;
  preview: string;
  /** Пусто для «группы» с дочерними пунктами — вставка только у детей */
  pasteText?: string;
  children?: TemplateChild[];
};

type FlatItem = {
  id: string;
  row: TemplateRow | TemplateChild;
  depth: number;
  pasteText: string;
};

const VAR_MAP: Record<string, string> = {
  user: "Алексей",
  mail: "alex@example.com",
};

function substituteVars(text: string): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => VAR_MAP[key] ?? `{${key}}`);
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

const MOCK_TEMPLATES: TemplateRow[] = [
  {
    id: "1",
    title: "Приветствие",
    preview: "Добрый день, {user}! …",
    pasteText: "Добрый день, {user}!\n\nРад снова на связи.",
  },
  {
    id: "2",
    title: "Подпись",
    preview: "Варианты подписи",
    children: [
      {
        id: "2a",
        title: "Краткая",
        preview: "С уважением, {user}",
        pasteText: "С уважением,\n{user}",
      },
      {
        id: "2b",
        title: "Полная",
        preview: "{user} · {mail}",
        pasteText: "С уважением,\n{user}\n{mail}",
      },
    ],
  },
  {
    id: "3",
    title: "Следующий шаг",
    preview: "Напишите, когда будет удобно созвониться.",
    pasteText:
      "Напишите, пожалуйста, когда вам будет удобно коротко созвониться.",
  },
];

function useModKey() {
  return useMemo(() => {
    if (typeof navigator === "undefined") return "Ctrl";
    return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
  }, []);
}

function flattenForFilter(rows: TemplateRow[], query: string): FlatItem[] {
  const q = query.trim().toLowerCase();
  const out: FlatItem[] = [];

  for (const r of rows) {
    const matchSelf =
      !q ||
      r.title.toLowerCase().includes(q) ||
      r.preview.toLowerCase().includes(q);
    const childMatches = r.children?.filter(
      (c) =>
        !q ||
        c.title.toLowerCase().includes(q) ||
        c.preview.toLowerCase().includes(q)
    );

    if (matchSelf) {
      out.push({
        id: r.id,
        row: r,
        depth: 0,
        pasteText: getPasteText(r),
      });
      if (r.children?.length) {
        const toAdd = q ? (childMatches?.length ? childMatches : []) : r.children;
        for (const c of toAdd) {
          out.push({
            id: c.id,
            row: c,
            depth: 1,
            pasteText: getPasteText(c),
          });
        }
      }
    } else if (childMatches?.length) {
      out.push({
        id: r.id,
        row: r,
        depth: 0,
        pasteText: getPasteText(r),
      });
      for (const c of childMatches) {
        out.push({
          id: c.id,
          row: c,
          depth: 1,
          pasteText: getPasteText(c),
        });
      }
    }
  }

  return out;
}

function App() {
  const mod = useModKey();
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const selectedIndexRef = useRef(0);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filtered = useMemo(() => flattenForFilter(MOCK_TEMPLATES, query), [query]);

  selectedIndexRef.current = selectedIndex;

  const hide = useCallback(() => {
    void invoke("palette_hide");
  }, []);

  const insertTemplate = useCallback(async (raw: string) => {
    const text = substituteVars(raw).trim();
    if (!text) return;
    try {
      await invoke("paste_template", { text });
    } catch {
      /* см. README: macOS — доступ для Snipcast и osascript к «Универсальный доступ» */
    }
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIndex, filtered]);

  useEffect(() => {
    let unlistenFocus: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          setQuery("");
          setSelectedIndex(0);
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
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
        return;
      }

      if (filtered.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const idx = selectedIndexRef.current;
        const item = filtered[idx];
        if (item) void insertTemplate(item.pasteText);
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, hide, insertTemplate]);

  const activeId =
    filtered.length > 0 ? `snipcast-opt-${filtered[selectedIndex]?.id}` : undefined;

  return (
    <div className="palette">
      <header className="palette__chrome" data-tauri-drag-region>
        <input
          ref={searchRef}
          className="palette__search"
          type="text"
          placeholder="Search templates…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-controls="snipcast-listbox"
          aria-activedescendant={activeId}
        />
      </header>

      <ul
        id="snipcast-listbox"
        className="palette__list"
        role="listbox"
        aria-label="Шаблоны"
      >
        {filtered.length === 0 ? (
          <li className="palette__empty">Нет совпадений</li>
        ) : (
          filtered.map((item, index) => (
            <li
              key={item.id}
              id={`snipcast-opt-${item.id}`}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              className={`palette__item palette__item--depth-${item.depth}${
                index === selectedIndex ? " palette__item--selected" : ""
              }${!item.pasteText.trim() ? " palette__item--inactive" : ""}`}
              role="option"
              aria-selected={index === selectedIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => {
                if (!item.pasteText.trim()) return;
                void insertTemplate(item.pasteText);
              }}
            >
              <div className="palette__item-title">{item.row.title}</div>
              <div className="palette__item-preview">{item.row.preview}</div>
            </li>
          ))
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
          <kbd>Esc</kbd> закрыть
        </span>
        <span className="palette__hints-muted">
          Палитра: {mod}+Shift+Space
        </span>
      </footer>
    </div>
  );
}

export default App;
