"""Окно палитры — зеркало src/App.tsx + src/App.css (CustomTkinter)."""

from __future__ import annotations

import platform
import sys
from typing import List, Optional

import customtkinter as ctk

from snipcast_ctk.data import (
    MOCK_TEMPLATES,
    FlatItem,
    flatten_for_filter,
    substitute_vars,
)
from snipcast_ctk.paste_target import paste_template, refresh_paste_target

# Токены из App.css
BG = "#1b1b1f"
BORDER = "#2a2a32"
TEXT_BRIGHT = "#f4f4f8"
PLACEHOLDER = "#6b6b78"
EMPTY = "#7a7a88"
PREVIEW = "#8b8b98"
HOVER = "#25252c"
SELECTED = "#2e3248"
SELECTED_HOVER = "#343a54"
INACTIVE_SELECTED = "#25252c"
DEPTH_LINE = "#3a3a44"
HINTS = "#9a9aa8"
KBD_BG = "#121214"
KBD_BORDER = "#3a3a44"
KBD_TEXT = "#c4c4ce"


def _mod_symbol() -> str:
    return "⌘" if platform.system() == "Darwin" else "Ctrl"


class PaletteWindow(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Snipcast")
        self.configure(fg_color=BG)
        self.minsize(480, 320)
        self.geometry("560x400")
        self.overrideredirect(True)
        self.attributes("-topmost", True)

        self._row_frames: List[ctk.CTkFrame] = []
        self._filtered: List[FlatItem] = []
        self._selected_index = 0
        self._hover_row: Optional[int] = None
        self._focus_check_after: Optional[str] = None

        self._build_ui()
        self._bind_keys()
        self.withdraw()

    def _build_ui(self) -> None:
        outer = ctk.CTkFrame(self, fg_color=BG, corner_radius=12)
        outer.pack(fill="both", expand=True, padx=0, pady=0)

        chrome = ctk.CTkFrame(outer, fg_color=BG, corner_radius=0)
        chrome.pack(fill="x", padx=0, pady=0)
        chrome.configure(border_width=0)

        inner_search = ctk.CTkFrame(chrome, fg_color=BG)
        inner_search.pack(fill="x", padx=12, pady=(10, 8))
        sep1 = ctk.CTkFrame(chrome, fg_color=BORDER, height=1)
        sep1.pack(fill="x", side="bottom")

        self._search = ctk.CTkEntry(
            inner_search,
            placeholder_text="Search templates…",
            height=36,
            fg_color=BG,
            border_width=0,
            text_color=TEXT_BRIGHT,
            placeholder_text_color=PLACEHOLDER,
            font=ctk.CTkFont(size=15),
        )
        self._search.pack(fill="x", padx=4, pady=(0, 0))

        self.list_sf = ctk.CTkScrollableFrame(
            outer,
            fg_color=BG,
            corner_radius=0,
            scrollbar_button_color=DEPTH_LINE,
            scrollbar_fg_color=BORDER,
        )
        self.list_sf.pack(fill="both", expand=True, padx=0, pady=(6, 0))

        foot = ctk.CTkFrame(outer, fg_color=BG, corner_radius=0)
        foot.pack(fill="x", padx=0, pady=0)
        sep2 = ctk.CTkFrame(foot, fg_color=BORDER, height=1)
        sep2.pack(fill="x", side="top")

        hints_inner = ctk.CTkFrame(foot, fg_color=BG)
        hints_inner.pack(fill="x", padx=12, pady=(8, 10))

        mod = _mod_symbol()
        row_hints = ctk.CTkFrame(hints_inner, fg_color=BG)
        row_hints.pack(fill="x")

        self._add_hint_chunk(row_hints, ("↑", "↓"), " навигация")
        self._add_hint_chunk(row_hints, ("Enter",), " вставить", padx=(12, 0))
        self._add_hint_chunk(row_hints, ("Esc",), " закрыть", padx=(12, 0))

        muted = ctk.CTkLabel(
            row_hints,
            text=f"Палитра: {mod}+Shift+Space",
            font=ctk.CTkFont(size=11),
            text_color=HINTS,
            anchor="e",
        )
        muted.pack(side="right")

        self._chrome_drag = chrome
        chrome.bind("<Button-1>", self._start_drag)
        chrome.bind("<B1-Motion>", self._on_drag)
        inner_search.bind("<Button-1>", self._start_drag)
        inner_search.bind("<B1-Motion>", self._on_drag)

        self._search.bind("<KeyRelease>", self._on_query_changed)
        self.protocol("WM_DELETE_WINDOW", self.hide_palette)

    def _add_hint_chunk(
        self,
        parent: ctk.CTkFrame,
        keys: tuple[str, ...],
        after: str,
        padx: tuple[int, int] = (0, 0),
    ) -> None:
        f = ctk.CTkFrame(parent, fg_color=BG)
        f.pack(side="left", padx=padx)
        for i, key in enumerate(keys):
            self._kbd(f, key, padx=(4, 0) if i else (0, 0))
        ctk.CTkLabel(
            f,
            text=after,
            font=ctk.CTkFont(size=11),
            text_color=HINTS,
        ).pack(side="left", padx=(6, 0))

    def _kbd(self, parent: ctk.CTkFrame, text: str, padx: tuple[int, int] = (0, 0)) -> None:
        k = ctk.CTkFrame(
            parent,
            fg_color=KBD_BG,
            corner_radius=4,
            border_width=1,
            border_color=KBD_BORDER,
        )
        k.pack(side="left", padx=padx)
        ctk.CTkLabel(
            k,
            text=text,
            font=ctk.CTkFont(size=10),
            text_color=KBD_TEXT,
        ).pack(padx=6, pady=2)

    def _start_drag(self, event) -> None:
        self._drag_xy = (event.x_root, event.y_root, self.winfo_x(), self.winfo_y())

    def _on_drag(self, event) -> None:
        if not self._drag_xy:
            return
        dx = event.x_root - self._drag_xy[0]
        dy = event.y_root - self._drag_xy[1]
        self.geometry(f"+{self._drag_xy[2] + dx}+{self._drag_xy[3] + dy}")

    _drag_xy: Optional[tuple[int, int, int, int]] = None

    def _bind_keys(self) -> None:
        for w in (self, self._search):
            w.bind("<Down>", self._on_down)
            w.bind("<Up>", self._on_up)
            w.bind("<Return>", self._on_enter)
            w.bind("<KP_Enter>", self._on_enter)
            w.bind("<Escape>", self._on_esc)

        self.bind("<FocusOut>", self._on_focus_out)

    def _on_focus_out(self, event) -> None:
        if self._focus_check_after:
            self.after_cancel(self._focus_check_after)
        self._focus_check_after = self.after(150, self._check_focus_lost)

    def _check_focus_lost(self) -> None:
        self._focus_check_after = None
        if not self.winfo_viewable():
            return
        try:
            w = self.focus_get()
        except Exception:
            w = None
        if w is None:
            self.hide_palette()

    def _on_query_changed(self, _event=None) -> None:
        self._selected_index = 0
        self._rebuild_list()

    def _filtered_items(self) -> List[FlatItem]:
        return flatten_for_filter(MOCK_TEMPLATES, self._search.get())

    def _rebuild_list(self) -> None:
        for w in self.list_sf.winfo_children():
            w.destroy()
        self._row_frames.clear()
        self._filtered = self._filtered_items()

        if not self._filtered:
            empty = ctk.CTkLabel(
                self.list_sf,
                text="Нет совпадений",
                font=ctk.CTkFont(size=14),
                text_color=EMPTY,
            )
            empty.pack(pady=24, padx=12)
            return

        for i, item in enumerate(self._filtered):
            row = self._make_row(item, i)
            self._row_frames.append(row)
            padx = (14, 6) if item.depth else (6, 6)
            row.pack(fill="x", padx=padx, pady=2)

        self._apply_selection()

    def _make_row(self, item: FlatItem, index: int) -> ctk.CTkFrame:
        inactive = not item.pasteText.strip()
        depth = item.depth

        if depth:
            row_wrap = ctk.CTkFrame(self.list_sf, fg_color="transparent")
            accent = ctk.CTkFrame(
                row_wrap, fg_color=DEPTH_LINE, width=2, corner_radius=0
            )
            accent.pack(side="left", fill="y", padx=(8, 0), pady=2)
            frame = ctk.CTkFrame(row_wrap, fg_color="transparent", corner_radius=8)
            frame.pack(side="left", fill="both", expand=True)
        else:
            row_wrap = None
            frame = ctk.CTkFrame(self.list_sf, fg_color="transparent", corner_radius=8)

        inner = ctk.CTkFrame(frame, fg_color="transparent")
        inner.pack(fill="x", padx=(12, 12), pady=10)

        dim = 0.72 if inactive else 1.0
        title_c = TEXT_BRIGHT if dim == 1 else "#b5b5bd"
        preview_c = PREVIEW if dim == 1 else "#6a6a76"

        title = ctk.CTkLabel(
            inner,
            text=item.row["title"],
            font=ctk.CTkFont(size=14, weight="bold"),
            text_color=title_c,
            anchor="w",
        )
        title.pack(fill="x")

        prev = ctk.CTkLabel(
            inner,
            text=item.row["preview"],
            font=ctk.CTkFont(size=12),
            text_color=preview_c,
            anchor="w",
        )
        prev.pack(fill="x", pady=(2, 0))

        def on_mouse_enter(_e) -> None:
            self._selected_index = index
            self._hover_row = index
            self._apply_selection()

        def on_mouse_leave(_e) -> None:
            if self._hover_row == index:
                self._hover_row = None
            self._apply_selection()

        def on_click(_e) -> None:
            if not item.pasteText.strip():
                return
            self._insert(item.pasteText)

        bound = [frame, inner, title, prev]
        if row_wrap is not None:
            bound.extend([row_wrap, accent])
        for w in bound:
            w.bind("<Enter>", on_mouse_enter)
            w.bind("<Leave>", on_mouse_leave)
            w.bind("<Button-1>", on_click)

        if row_wrap is not None:
            row_wrap._snipcast_row = frame  # type: ignore[attr-defined]
            frame._snipcast_inactive = inactive  # type: ignore[attr-defined]
            frame._snipcast_index = index  # type: ignore[attr-defined]
            return row_wrap

        frame._snipcast_inactive = inactive  # type: ignore[attr-defined]
        frame._snipcast_index = index  # type: ignore[attr-defined]
        return frame

    def _row_frame_at(self, index: int) -> Optional[ctk.CTkFrame]:
        if index < 0 or index >= len(self._row_frames):
            return None
        w = self._row_frames[index]
        inner = getattr(w, "_snipcast_row", None)
        return inner if inner is not None else w

    def _apply_row_style(self, index: int) -> None:
        frame = self._row_frame_at(index)
        if frame is None:
            return
        inactive = getattr(frame, "_snipcast_inactive", False)
        sel = index == self._selected_index
        hover = index == self._hover_row
        if inactive:
            if sel:
                frame.configure(fg_color=INACTIVE_SELECTED)
            else:
                frame.configure(fg_color="transparent")
            return
        if sel:
            frame.configure(fg_color=SELECTED_HOVER if hover else SELECTED)
        else:
            frame.configure(fg_color=HOVER if hover else "transparent")

    def _apply_selection(self) -> None:
        for i in range(len(self._row_frames)):
            self._apply_row_style(i)
        self._scroll_to_index(self._selected_index)

    def _scroll_to_index(self, index: int) -> None:
        if index < 0 or index >= len(self._row_frames):
            return
        row = self._row_frames[index]
        try:
            canvas = self.list_sf._parent_canvas  # type: ignore[attr-defined]
            inner = self.list_sf._scrollable_frame  # type: ignore[attr-defined]
        except Exception:
            return
        self.update_idletasks()
        try:
            ch = canvas.winfo_height()
            ih = inner.winfo_reqheight()
            if ih <= ch:
                return
            y1 = row.winfo_y()
            rh = row.winfo_height() or 56
            center = y1 + rh / 2 - ch / 2
            total = max(1, ih - ch)
            frac = max(0.0, min(1.0, center / total))
            canvas.yview_moveto(frac)
        except Exception:
            pass

    def _on_down(self, event) -> str:
        self._hover_row = None
        if not self._filtered:
            return "break"
        self._selected_index = min(self._selected_index + 1, len(self._filtered) - 1)
        self._apply_selection()
        return "break"

    def _on_up(self, event) -> str:
        self._hover_row = None
        if not self._filtered:
            return "break"
        self._selected_index = max(self._selected_index - 1, 0)
        self._apply_selection()
        return "break"

    def _on_enter(self, event) -> str:
        if not self._filtered:
            return "break"
        idx = self._selected_index
        if 0 <= idx < len(self._filtered):
            t = self._filtered[idx].pasteText
            if t.strip():
                self._insert(t)
        return "break"

    def _on_esc(self, event) -> str:
        self.hide_palette()
        return "break"

    def _insert(self, raw: str) -> None:
        text = substitute_vars(raw).strip()
        if not text:
            return
        try:
            paste_template(text, self.hide_palette)
        except Exception as e:
            print(f"[snipcast] paste: {e}", file=sys.stderr)

    def hide_palette(self) -> None:
        if self._focus_check_after:
            try:
                self.after_cancel(self._focus_check_after)
            except Exception:
                pass
            self._focus_check_after = None
        self.withdraw()

    def show_palette(self) -> None:
        refresh_paste_target()
        self._search.delete(0, "end")
        self._selected_index = 0
        self._rebuild_list()
        self._center_on_screen()
        self.deiconify()
        self.lift()
        self.attributes("-topmost", True)
        self.after(10, self._focus_search)

    def _center_on_screen(self) -> None:
        self.update_idletasks()
        w, h = 560, 400
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        x = max(0, (sw - w) // 2)
        y = max(0, (sh - h) // 2)
        self.geometry(f"{w}x{h}+{x}+{y}")

    def _focus_search(self) -> None:
        self._search.focus_set()
        self._search.select_range(0, "end")


def run_palette_main() -> None:
    ctk.set_appearance_mode("dark")
    ctk.set_default_color_theme("dark-blue")
    app = PaletteWindow()
    app.show_palette()
    app.mainloop()
