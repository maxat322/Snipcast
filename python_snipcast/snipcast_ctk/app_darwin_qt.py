"""
macOS: палитра на Qt — обход краша Tcl/Tk (TkSetMacColor → NSApplication macOSVersion).

На новых версиях macOS встроенный Tk у многих сборок Python несовместим; Qt не использует Tk.
"""

from __future__ import annotations

import platform
import sys
import threading
from pathlib import Path

from PySide6.QtCore import QObject, QPoint, Qt, Signal, QTimer
from PySide6.QtGui import QAction, QColor, QFont, QIcon, QKeySequence, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QSystemTrayIcon,
    QVBoxLayout,
    QWidget,
)

from snipcast_ctk.data import MOCK_TEMPLATES, FlatItem, flatten_for_filter, substitute_vars
from snipcast_ctk.paste_target import paste_template, refresh_paste_target

BG = "#1b1b1f"
BORDER = "#2a2a32"
TEXT_BRIGHT = "#f4f4f8"
EMPTY = "#7a7a88"
PREVIEW = "#8b8b98"
SELECTED = "#2e3248"
SELECTED_HOVER = "#343a54"
DEPTH_LINE = "#3a3a44"
HINTS = "#9a9aa8"
KBD_BG = "#121214"
KBD_BORDER = "#3a3a44"
KBD_TEXT = "#c4c4ce"


def _load_tray_icon() -> QIcon:
    here = Path(__file__).resolve()
    repo = here.parent.parent.parent
    p = repo / "src-tauri" / "icons" / "32x32.png"
    if p.exists():
        return QIcon(str(p))
    pix = QPixmap(32, 32)
    pix.fill(QColor(BG))
    return QIcon(pix)


class Signaler(QObject):
    show_requested = Signal()


class SearchLineEdit(QLineEdit):
    def __init__(self, list_widget: QListWidget, on_enter) -> None:
        super().__init__()
        self._list = list_widget
        self._on_enter = on_enter

    def keyPressEvent(self, event) -> None:
        key = event.key()
        if key in (Qt.Key.Key_Down, Qt.Key.Key_Up) and self._list.count() > 0:
            row = self._list.currentRow()
            if row < 0:
                row = 0
            if key == Qt.Key.Key_Down:
                row = min(row + 1, self._list.count() - 1)
            else:
                row = max(row - 1, 0)
            self._list.setCurrentRow(row)
            self._list.scrollToItem(self._list.currentItem())
            event.accept()
            return
        if key in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            self._on_enter()
            event.accept()
            return
        super().keyPressEvent(event)


class PaletteQt(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self._filtered: list[FlatItem] = []
        self._drag_pos: QPoint | None = None

        self.setWindowTitle("Snipcast")
        self.setMinimumSize(480, 320)
        self.resize(560, 400)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setStyleSheet(f"background-color: {BG}; border-radius: 12px;")

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        chrome = QFrame()
        chrome.setStyleSheet(f"background-color: {BG}; border: none;")
        chrome_l = QVBoxLayout(chrome)
        chrome_l.setContentsMargins(12, 10, 12, 8)
        chrome_l.setSpacing(0)

        self.list_w = QListWidget()
        self.search = SearchLineEdit(self.list_w, self._on_enter_key)

        self.search.setPlaceholderText("Search templates…")
        self.search.setStyleSheet(
            f"""
            QLineEdit {{
                background: {BG};
                border: none;
                color: {TEXT_BRIGHT};
                font-size: 15px;
                padding: 8px 4px;
            }}
            """
        )
        self.search.textChanged.connect(self._on_query)
        chrome_l.addWidget(self.search)

        sep1 = QFrame()
        sep1.setFixedHeight(1)
        sep1.setStyleSheet(f"background-color: {BORDER};")
        chrome_l.addWidget(sep1)
        root.addWidget(chrome)

        self.list_w.setStyleSheet(
            f"""
            QListWidget {{
                background: {BG};
                border: none;
                outline: none;
                padding: 6px;
            }}
            QListWidget::item {{
                background: transparent;
                padding: 0px;
                margin: 2px 6px;
            }}
            QListWidget::item:selected {{
                background: {SELECTED};
                border-radius: 8px;
            }}
            QListWidget::item:hover {{
                background: {SELECTED_HOVER};
                border-radius: 8px;
            }}
            QScrollBar:vertical {{
                background: {BORDER};
                width: 8px;
                border-radius: 4px;
            }}
            QScrollBar::handle:vertical {{
                background: {DEPTH_LINE};
                border-radius: 4px;
                min-height: 24px;
            }}
            """
        )
        self.list_w.setSpacing(2)
        self.list_w.itemClicked.connect(self._on_item_clicked)
        self.list_w.itemActivated.connect(self._on_item_clicked)
        root.addWidget(self.list_w, stretch=1)

        foot = QFrame()
        foot.setStyleSheet(f"background-color: {BG};")
        fl = QVBoxLayout(foot)
        fl.setContentsMargins(0, 0, 0, 0)
        sep2 = QFrame()
        sep2.setFixedHeight(1)
        sep2.setStyleSheet(f"background-color: {BORDER};")
        fl.addWidget(sep2)
        hints = QHBoxLayout()
        hints.setContentsMargins(12, 8, 12, 10)
        hints.setSpacing(16)
        self._add_hints(hints)
        fl.addLayout(hints)
        root.addWidget(foot)

        esc = QShortcut(QKeySequence(Qt.Key.Key_Escape), self)
        esc.activated.connect(self.hide)

        self.hide()

    def mousePressEvent(self, event) -> None:
        if (
            event.button() == Qt.MouseButton.LeftButton
            and event.position().y() < 72
        ):
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._drag_pos is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_pos)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_pos = None
        super().mouseReleaseEvent(event)

    def _kbd_label(self, text: str) -> QLabel:
        l = QLabel(text)
        l.setStyleSheet(
            f"""
            QLabel {{
                background: {KBD_BG};
                color: {KBD_TEXT};
                border: 1px solid {KBD_BORDER};
                border-radius: 4px;
                padding: 2px 6px;
                font-size: 10px;
            }}
            """
        )
        return l

    def _add_hints(self, row: QHBoxLayout) -> None:
        def chunk(keys: tuple[str, ...], after: str) -> QWidget:
            w = QWidget()
            hl = QHBoxLayout(w)
            hl.setContentsMargins(0, 0, 0, 0)
            hl.setSpacing(4)
            for i, k in enumerate(keys):
                hl.addWidget(self._kbd_label(k))
            lab = QLabel(after)
            lab.setStyleSheet(f"color: {HINTS}; font-size: 11px;")
            hl.addWidget(lab)
            return w

        row.addWidget(chunk(("↑", "↓"), " навигация"))
        row.addWidget(chunk(("Enter",), " вставить"))
        row.addWidget(chunk(("Esc",), " закрыть"))
        row.addStretch()
        mod = "⌘" if platform.system() == "Darwin" else "Ctrl"
        muted = QLabel(f"Палитра: {mod}+Shift+Space")
        muted.setStyleSheet(f"color: {HINTS}; font-size: 11px; opacity: 0.85;")
        row.addWidget(muted)

    def _on_query(self, _t: str) -> None:
        self._rebuild_list()

    def _rebuild_list(self) -> None:
        self.list_w.clear()
        self._filtered = flatten_for_filter(MOCK_TEMPLATES, self.search.text())
        if not self._filtered:
            item = QListWidgetItem("Нет совпадений")
            item.setFlags(Qt.ItemFlag.NoItemFlags)
            f = QFont()
            f.setPointSize(14)
            item.setFont(f)
            item.setForeground(QColor(EMPTY))
            self.list_w.addItem(item)
            return

        for i, it in enumerate(self._filtered):
            row_w = QWidget()
            hl = QHBoxLayout(row_w)
            hl.setContentsMargins(0, 0, 0, 0)
            if it.depth:
                bar = QFrame()
                bar.setFixedWidth(2)
                bar.setStyleSheet(f"background-color: {DEPTH_LINE}; border-radius: 1px;")
                hl.addWidget(bar)
                hl.addSpacing(8)
            inner = QVBoxLayout()
            inner.setContentsMargins(12, 10, 12, 10)
            inner.setSpacing(2)
            inactive = not it.pasteText.strip()
            title_c = "#b5b5bd" if inactive else TEXT_BRIGHT
            prev_c = "#6a6a76" if inactive else PREVIEW
            t = QLabel(it.row["title"])
            t.setStyleSheet(f"font-weight: 600; font-size: 14px; color: {title_c};")
            p = QLabel(it.row["preview"])
            p.setStyleSheet(f"font-size: 12px; color: {prev_c};")
            p.setWordWrap(False)
            inner.addWidget(t)
            inner.addWidget(p)
            hl.addLayout(inner, stretch=1)

            item = QListWidgetItem()
            self.list_w.addItem(item)
            self.list_w.setItemWidget(item, row_w)
            row_w.adjustSize()
            item.setSizeHint(row_w.sizeHint())
            item.setData(Qt.ItemDataRole.UserRole, i)

        self.list_w.setCurrentRow(0)

    def _current_paste_text(self) -> str:
        row = self.list_w.currentRow()
        if row < 0 or row >= len(self._filtered):
            return ""
        return self._filtered[row].pasteText

    def _on_enter_key(self) -> None:
        t = self._current_paste_text().strip()
        if t:
            self._do_paste(t)

    def _on_item_clicked(self, item: QListWidgetItem) -> None:
        idx = item.data(Qt.ItemDataRole.UserRole)
        if idx is None:
            return
        i = int(idx)
        if 0 <= i < len(self._filtered):
            t = self._filtered[i].pasteText.strip()
            if t:
                self._do_paste(self._filtered[i].pasteText)

    def _do_paste(self, raw: str) -> None:
        text = substitute_vars(raw).strip()
        if not text:
            return
        try:
            paste_template(text, self.hide)
        except Exception as e:
            print(f"[snipcast] paste: {e}", file=sys.stderr)

    def show_palette(self) -> None:
        refresh_paste_target()
        self.search.blockSignals(True)
        self.search.clear()
        self.search.blockSignals(False)
        self._rebuild_list()
        self._center()
        self.show()
        self.raise_()
        self.activateWindow()
        self.search.setFocus()

    def _center(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        g = self.frameGeometry()
        g.moveCenter(screen.availableGeometry().center())
        self.move(g.topLeft())

    def focusOutEvent(self, event) -> None:
        super().focusOutEvent(event)
        QTimer.singleShot(150, self._maybe_hide_on_focus)

    def _maybe_hide_on_focus(self) -> None:
        if not self.isVisible():
            return
        fw = QApplication.focusWidget()
        if fw is not None and self.isAncestorOf(fw):
            return
        self.hide()


def _run_hotkey(signaler: Signaler) -> None:
    from pynput import keyboard

    combo = "<cmd>+<shift>+<space>"
    hotkeys = {combo: lambda: signaler.show_requested.emit()}
    with keyboard.GlobalHotKeys(hotkeys) as h:
        h.join()


def run() -> None:
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    signaler = Signaler()
    palette = PaletteQt()
    signaler.show_requested.connect(palette.show_palette)

    icon = QSystemTrayIcon(_load_tray_icon(), parent=None)
    icon.setToolTip("Snipcast")
    menu = QMenu()
    show_a = QAction("Show palette", menu)
    show_a.triggered.connect(palette.show_palette)
    menu.addAction(show_a)
    quit_a = QAction("Quit Snipcast", menu)
    quit_a.triggered.connect(app.quit)
    menu.addAction(quit_a)
    icon.setContextMenu(menu)
    icon.show()

    def tray_activated(reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            palette.show_palette()

    icon.activated.connect(tray_activated)

    threading.Thread(target=lambda: _run_hotkey(signaler), name="snipcast-hotkey", daemon=True).start()

    sys.exit(app.exec())
