import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import type { AiChatMessage, AppConfig } from "../types";
import { applyUiThemeSetting, normalizeUiTheme } from "../uiTheme";
import "./aiagent.css";

/** История чата, как её отдаёт бэкенд (snipcast_ai_history). */
type AiHistory = {
  messages: AiChatMessage[];
  /** Картинки, прикреплённые из оверлея: уйдут со следующим сообщением. */
  pendingImageIds: number[];
};

/** Сообщение в ленте: история бэкенда + локальные маркеры стриминга/ошибки. */
type UiMessage = {
  key: string;
  role: "user" | "assistant";
  text: string;
  imageIds: number[];
  /** true, пока ответ стримится (ждём дельты/резолв snipcast_ai_send). */
  streaming: boolean;
  /** Текст ошибки, если snipcast_ai_send отклонился. */
  error: string;
};

function toUiMessage(m: AiChatMessage, key: string): UiMessage {
  return { key, role: m.role, text: m.text, imageIds: m.imageIds ?? [], streaming: false, error: "" };
}

/** Иконка копирования под сообщением. */
function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12.5l4.5 4.5L19 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Размеры окна (логические), синхронизированы с ai.rs: сначала компактное
 *  поле ввода, после первого ответа — полный чат. */
const WIN_W = 420;
const WIN_COMPACT_H = 72;
const WIN_FULL_H = 560;

// ---------------------------------------------------------------------------
// Мини-рендер ответа ассистента: фенсы ``` → блоки кода, инлайн `...` → code,
// остальное — абзацами. Без markdown-библиотек.
// ---------------------------------------------------------------------------

function renderInline(text: string, keyBase: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((seg, j) => {
    if (seg.length > 2 && seg.startsWith("`") && seg.endsWith("`")) {
      return (
        <code key={`${keyBase}-c${j}`} className="aiagent__inline-code">
          {seg.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyBase}-t${j}`}>{seg}</span>;
  });
}

function renderAssistantText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Нечётные куски — внутри фенсов: первая строка может быть меткой языка.
  text.split("```").forEach((part, i) => {
    if (i % 2 === 1) {
      const body = part.includes("\n") ? part.replace(/^[^\n]*\n/, "") : part;
      out.push(
        <pre key={`blk${i}`} className="aiagent__code">
          <code>{body}</code>
        </pre>,
      );
      return;
    }
    part
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .forEach((para, j) => {
        out.push(
          <p key={`p${i}-${j}`} className="aiagent__para">
            {renderInline(para, `p${i}-${j}`)}
          </p>,
        );
      });
  });
  return out;
}

// ---------------------------------------------------------------------------

export function AiAgentApp() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [pending, setPending] = useState<number[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  /** Ключ сообщения, скопированного в буфер (для галочки на кнопке). */
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  /** false — компактное окно одного поля ввода; полный чат после первого ответа. */
  const [expanded, setExpanded] = useState(false);
  /** objectURL миниатюр: imageId → url. */
  const [imgUrls, setImgUrls] = useState<Record<number, string>>({});

  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Прокручиваем ленту вниз, только пока пользователь сам у нижнего края. */
  const stickRef = useRef(true);
  const keySeqRef = useRef(0);
  const urlCacheRef = useRef<Map<number, string>>(new Map());
  const requestedRef = useRef<Set<number>>(new Set());
  const unAttachRef = useRef<(() => void) | null>(null);
  const unDeltaRef = useRef<(() => void) | null>(null);

  const nextKey = () => `m${keySeqRef.current++}`;

  // ------------------------------------------------------------------
  // Загрузка конфига и истории
  // ------------------------------------------------------------------

  useEffect(() => {
    let dead = false;
    void invoke<AppConfig>("snipcast_get_config")
      .then((c) => {
        if (dead) return;
        setCfg(c);
        applyUiThemeSetting(normalizeUiTheme(c.theme));
      })
      .catch((e) => console.error("[Snipcast] не удалось загрузить настройки:", e));
    void invoke<AiHistory>("snipcast_ai_history")
      .then((h) => {
        if (dead) return;
        setMessages(h.messages.map((m) => toUiMessage(m, nextKey())));
        setPending(h.pendingImageIds ?? []);
        // Чат уже был (окно переоткрыли) — сразу полный размер.
        setExpanded((h.messages?.length ?? 0) > 0);
      })
      .catch((e) => console.error("[Snipcast] не удалось загрузить историю чата:", e));
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Компактное поле ввода сразу получает фокус (окно только что открылось
  // под тулбаром — можно сразу печатать промпт). WebView грузится позже
  // показа окна, поэтому фокус добираем несколькими попытками.
  useEffect(() => {
    if (expanded) return;
    let stop = false;
    const focusInput = () => {
      if (stop) return;
      void getCurrentWindow()
        .setFocus()
        .catch(() => {
          /* окно могло уже закрыться */
        });
      inputRef.current?.focus();
    };
    const timers = [150, 500, 1200, 2000].map((d) => window.setTimeout(focusInput, d));
    return () => {
      stop = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [expanded]);

  // Esc закрывает окно чата независимо от того, где фокус.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      void getCurrentWindow().close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // ------------------------------------------------------------------
  // События бэкенда: новая картинка из оверлея и дельты стриминга
  // ------------------------------------------------------------------

  useEffect(() => {
    // Unmount может случиться раньше, чем резолвится listen() (StrictMode) —
    // тогда отписываемся сразу по факту, иначе листенер переживёт эффект
    // и дельты будут задваиваться.
    let dead = false;
    void listen<{ imageId: number }>("snipcast://ai-attach", (e) => {
      setPending((prev) => (prev.includes(e.payload.imageId) ? prev : [...prev, e.payload.imageId]));
      // Окно только что открылось для ввода промпта — сразу в поле.
      inputRef.current?.focus();
    }).then((f) => {
      if (dead) f();
      else unAttachRef.current = f;
    });
    void listen<{ text: string }>("snipcast://ai-delta", (e) => {
      // Ответ начал приходить — разворачиваем компактное окно в чат.
      setExpanded(true);
      setMessages((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (!prev[i].streaming) continue;
          const next = [...prev];
          next[i] = { ...next[i], text: next[i].text + e.payload.text };
          return next;
        }
        // Пузыря ещё нет (окно открылось во время ответа) — создаём.
        return [
          ...prev,
          { key: nextKey(), role: "assistant", text: e.payload.text, imageIds: [], streaming: true, error: "" },
        ];
      });
    }).then((f) => {
      if (dead) f();
      else unDeltaRef.current = f;
    });
    return () => {
      dead = true;
      unAttachRef.current?.();
      unDeltaRef.current?.();
      unAttachRef.current = null;
      unDeltaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------
  // Миниатюры: PNG-байты по imageId → objectURL (кэш на ref, revoke на unmount)
  // ------------------------------------------------------------------

  const ensureImage = useCallback((id: number) => {
    if (requestedRef.current.has(id)) return;
    requestedRef.current.add(id);
    void invoke<ArrayBuffer>("snipcast_ai_image", { id })
      .then((buf) => {
        const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        urlCacheRef.current.set(id, url);
        setImgUrls((prev) => ({ ...prev, [id]: url }));
      })
      .catch((e) => console.error("[Snipcast] не удалось загрузить изображение", id, e));
  }, []);

  useEffect(() => {
    const ids = new Set<number>();
    for (const m of messages) for (const id of m.imageIds) ids.add(id);
    for (const id of pending) ids.add(id);
    for (const id of ids) ensureImage(id);
  }, [messages, pending, ensureImage]);

  // Размонтирование (включая строгий режим) — отпускаем все objectURL.
  useEffect(() => {
    return () => {
      for (const url of urlCacheRef.current.values()) URL.revokeObjectURL(url);
      urlCacheRef.current.clear();
      requestedRef.current.clear();
    };
  }, []);

  // ------------------------------------------------------------------
  // Автопрокрутка ленты
  // ------------------------------------------------------------------

  const onFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = feedRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // ------------------------------------------------------------------
  // Размер окна: компакт → полный чат. Разворот — короткая анимация
  // (rAF + плавная кривая), сжатие после «Очистить чат» — мгновенное.
  // Первый рендер пропускаем: у нового окна размер задал бэкенд, у
  // переоткрытого с историей — разворот сделает загрузка истории.
  // ------------------------------------------------------------------

  const rafRef = useRef(0);
  const sizedOnceRef = useRef(false);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  useEffect(() => {
    if (!sizedOnceRef.current) {
      sizedOnceRef.current = true;
      return;
    }
    const win = getCurrentWindow();
    if (!expanded) {
      cancelAnimationFrame(rafRef.current);
      void win.setSize(new LogicalSize(WIN_W, WIN_COMPACT_H)).catch(() => {
        /* скрытое окно может не принять размер — не критично */
      });
      return;
    }
    void (async () => {
      // Целевую позицию считает бэкенд по рабочей области: если полный чат
      // не влезает снизу, окно приподнимаем — не под панель задач.
      let toX: number | null = null;
      let toY = 0;
      let fromY = 0;
      let fromH = 0;
      let scale = 1;
      try {
        const [origin, cur, sz, sc] = await Promise.all([
          invoke<{ x: number; y: number }>("snipcast_ai_expand_origin"),
          win.outerPosition(),
          win.outerSize(),
          win.scaleFactor(),
        ]);
        toX = origin.x;
        toY = origin.y;
        fromY = cur.y;
        fromH = sz.height;
        scale = sc;
      } catch {
        /* анимируем только высоту */
      }
      const t0 = performance.now();
      const dur = 240;
      cancelAnimationFrame(rafRef.current);
      // Разворот «из окна Думаю»: окно растёт вверх и вниз одновременно,
      // центр окна неподвижен (плюс плавный сдвиг к клампнутой позиции,
      // если разворот упирался в панель задач).
      const cStart = fromY + fromH / 2;
      const cTarget = toX !== null ? toY + (WIN_FULL_H * scale) / 2 : cStart;
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - k, 3);
        const h = WIN_COMPACT_H + (WIN_FULL_H - WIN_COMPACT_H) * eased;
        const center = cStart + (cTarget - cStart) * eased;
        void win.setSize(new LogicalSize(WIN_W, Math.round(h))).catch(() => {});
        if (toX !== null) {
          const y = Math.round(center - (h * scale) / 2);
          void win.setPosition(new PhysicalPosition(toX, y)).catch(() => {});
        }
        if (k < 1) rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    })();
  }, [expanded]);

  // ------------------------------------------------------------------
  // Ввод: рост 1–5 строк, Enter — отправить, Shift+Enter — перенос
  // ------------------------------------------------------------------

  const fitInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Максимум в 5 строк ограничивает max-height в CSS (с прокруткой).
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Пересчёт и после программной очистки поля (отправка), а не только по onChange.
  useEffect(() => {
    fitInput();
  }, [input, fitInput]);

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    const imageIds = pending;
    setInput("");
    setPending([]);
    fitInput();
    // Оптимистичный пузырь пользователя + плейсхолдер ответа со стримингом.
    setMessages((prev) => [
      ...prev,
      { key: nextKey(), role: "user", text, imageIds, streaming: false, error: "" },
      { key: nextKey(), role: "assistant", text: "", imageIds: [], streaming: true, error: "" },
    ]);
    setSending(true);
    try {
      // Промис резолвится полным ответом в конце; дельты приходят событием.
      const full = await invoke<string>("snipcast_ai_send", { text });
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, text: full, streaming: false } : m)));
    } catch (e) {
      // Частичный стриминговый текст сохраняем как текст пузыря.
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false, error: String(e) } : m)));
    } finally {
      setSending(false);
      // Ответа может не быть (ошибка/пустой стрим) — всё равно показываем чат.
      setExpanded(true);
    }
  }, [input, pending, sending, fitInput]);

  // Скопировать текст сообщения в буфер; на полторы секунды — галочка.
  const copyMessage = useCallback(async (m: UiMessage) => {
    if (!m.text) return;
    try {
      await invoke("snipcast_clipboard_write_text", { text: m.text });
      setCopiedKey(m.key);
      window.setTimeout(() => setCopiedKey(null), 1500);
    } catch (e) {
      console.error("[Snipcast] не удалось скопировать сообщение:", e);
    }
  }, []);

  const modelSub = cfg?.aiModel?.trim() ? cfg.aiModel.trim() : "модель не задана";
  const canSend = !sending && !!input.trim();

  // Панель ввода общая для компактного режима и полного чата.
  const composer = (
    <footer className="aiagent__composer">
      <div className="aiagent__input-row">
        <textarea
          ref={inputRef}
          className="aiagent__input"
          rows={1}
          value={input}
          placeholder="Спросите у ИИ Агента"
          spellCheck={false}
          onChange={(e) => {
            setInput(e.target.value);
            fitInput();
          }}
          onKeyDown={onInputKeyDown}
          aria-label="Вопрос для ИИ"
        />
        <button
          type="button"
          className="aiagent__send"
          disabled={!canSend}
          onClick={() => void send()}
          aria-label="Отправить"
          title="Отправить (Enter)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 20V5M5.5 11.5 12 5l6.5 6.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </footer>
  );

  return (
    <div className={`aiagent${expanded ? "" : " is-compact"}`}>
      {!expanded ? (
        // Компактный режим: до отправки — только поле ввода, после — «Думаю…».
        sending ? (
          <div className="aiagent__thinking" role="status">
            <span>Думаю</span>
            <span className="aiagent__dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : (
          composer
        )
      ) : (
        <>
          <header className="aiagent__header" data-tauri-drag-region>
            <img
              className="aiagent__logo"
              src="/Snipcast-icon-square.svg"
              alt=""
              aria-hidden
              draggable={false}
              data-tauri-drag-region
            />
            <div className="aiagent__heading" data-tauri-drag-region>
              <span className="aiagent__title" data-tauri-drag-region>
                ИИ Агент
              </span>
              <span className="aiagent__model" title={modelSub} data-tauri-drag-region>
                {modelSub}
              </span>
            </div>
            <div className="aiagent__header-actions">
              <button
                type="button"
                className="aiagent__close"
                aria-label="Закрыть окно"
                title="Закрыть (Esc)"
                onClick={() => void getCurrentWindow().close()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M6 6l12 12M18 6 6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </header>

          {cfg && !cfg.aiApiKey ? (
            <div className="aiagent__warn" role="alert">
              API-ключ не задан — Настройки → ИИ
            </div>
          ) : null}

          <div className="aiagent__feed" ref={feedRef} onScroll={onFeedScroll}>
            {messages.length === 0 ? (
              <div className="aiagent__empty">
                <p>Выделите область экрана и нажмите «ИИ Агент» на панели,</p>
                <p>затем задайте вопрос по скриншоту</p>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.key}
                  className={`aiagent__msg aiagent__msg--${m.role}${m.error ? " is-error" : ""}`}
                >
                  {m.imageIds.length > 0 ? (
                    <div className="aiagent__thumbs">
                      {m.imageIds.map((id) =>
                        imgUrls[id] ? (
                          <img key={id} className="aiagent__thumb" src={imgUrls[id]} alt="Скриншот" />
                        ) : (
                          <span key={id} className="aiagent__thumb aiagent__thumb--stub" aria-hidden />
                        ),
                      )}
                    </div>
                  ) : null}
                  <div className="aiagent__bubble">
                    {m.role === "assistant" ? (
                      <>
                        {renderAssistantText(m.text)}
                        {m.streaming ? (
                          <span className="aiagent__cursor" aria-hidden>
                            ▍
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="aiagent__text">{m.text}</span>
                    )}
                  </div>
                  {m.error ? <div className="aiagent__error">{m.error}</div> : null}
                  {!m.streaming ? (
                    <div className="aiagent__msg-actions">
                      <button
                        type="button"
                        className="aiagent__copy"
                        onClick={() => void copyMessage(m)}
                        aria-label="Копировать сообщение"
                        title="Копировать"
                      >
                        {copiedKey === m.key ? <IconCheck /> : <IconCopy />}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {pending.length > 0 ? (
            <div className="aiagent__pending" title="Уйдут со следующим сообщением">
              {pending.map((id) =>
                imgUrls[id] ? (
                  <img key={id} className="aiagent__thumb" src={imgUrls[id]} alt="Скриншот" />
                ) : (
                  <span key={id} className="aiagent__thumb aiagent__thumb--stub" aria-hidden />
                ),
              )}
            </div>
          ) : null}

          {composer}
        </>
      )}
    </div>
  );
}
