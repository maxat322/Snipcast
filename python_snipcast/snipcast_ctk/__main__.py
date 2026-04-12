"""Запуск Snipcast: трей, глобальный хоткей (⌘/Ctrl+Shift+Space), палитра."""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Прямой запуск `python …/snipcast_ctk/__main__.py` не кладёт родительскую папку в sys.path.
_pkg_root = Path(__file__).resolve().parent.parent
if str(_pkg_root) not in sys.path:
    sys.path.insert(0, str(_pkg_root))

import platform
import queue
import threading


def _env_truthy(name: str) -> bool:
    v = os.environ.get(name, "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _main_darwin_qt() -> None:
    """macOS: Qt вместо CustomTkinter — встроенный Tcl/Tk часто падает (NSApplication macOSVersion)."""
    try:
        from snipcast_ctk.app_darwin_qt import run as run_qt
    except ImportError as e:
        print(
            "Snipcast на macOS требует PySide6 (обход сломанного Tcl/Tk в этом Python):\n"
            "  pip install 'PySide6>=6.6.0'\n"
            f"Ошибка импорта: {e}",
            file=sys.stderr,
        )
        raise SystemExit(1) from e
    run_qt()


def _main_tk() -> None:
    import customtkinter as ctk
    import pystray
    from PIL import Image

    from snipcast_ctk.palette import PaletteWindow

    def _load_tray_image() -> Image.Image:
        here = Path(__file__).resolve()
        repo = here.parent.parent.parent
        icon_path = repo / "src-tauri" / "icons" / "32x32.png"
        if icon_path.exists():
            return Image.open(icon_path).convert("RGBA")
        return Image.new("RGBA", (32, 32), (27, 27, 31, 255))

    def _run_hotkey_loop(schedule_show) -> None:
        from pynput import keyboard

        combo = (
            "<cmd>+<shift>+<space>"
            if platform.system() == "Darwin"
            else "<ctrl>+<shift>+<space>"
        )
        hotkeys = {combo: schedule_show}
        with keyboard.GlobalHotKeys(hotkeys) as h:
            h.join()

    def _install_command_pump(app: PaletteWindow, cmd_q: queue.SimpleQueue[str]) -> None:
        def pump() -> None:
            try:
                while True:
                    cmd = cmd_q.get_nowait()
                    if cmd == "quit":
                        try:
                            app.quit()
                        except Exception:
                            pass
                        return
                    if cmd == "show":
                        app.show_palette()
            except queue.Empty:
                pass
            try:
                app.after(50, pump)
            except Exception:
                pass

        app.after(0, pump)

    ctk.set_appearance_mode("dark")
    ctk.set_default_color_theme("dark-blue")

    cmd_q: queue.SimpleQueue[str] = queue.SimpleQueue()

    def schedule_show() -> None:
        cmd_q.put("show")

    def schedule_quit() -> None:
        cmd_q.put("quit")

    def on_quit_click(tray_icon: pystray.Icon, _item) -> None:
        schedule_quit()
        try:
            tray_icon.stop()
        except Exception:
            pass

    image = _load_tray_image()
    menu = pystray.Menu(
        pystray.MenuItem("Show palette", lambda _i, _it: schedule_show(), default=True),
        pystray.MenuItem("Quit Snipcast", on_quit_click),
    )
    icon = pystray.Icon("snipcast", image, "Snipcast", menu)

    app = PaletteWindow()
    _install_command_pump(app, cmd_q)

    threading.Thread(
        target=lambda: _run_hotkey_loop(schedule_show),
        name="snipcast-hotkey",
        daemon=True,
    ).start()

    is_darwin = platform.system() == "Darwin"
    skip_tray = _env_truthy("SNIPCAST_NO_TRAY")

    def start_tray() -> None:
        if skip_tray:
            print(
                "Snipcast: трей отключён (SNIPCAST_NO_TRAY). Выход: закройте терминал или Ctrl+C.",
                file=sys.stderr,
            )
            return

        def run_tray() -> None:
            try:
                icon.run()
            except Exception as e:
                print(
                    f"Snipcast: трей недоступен ({e}). Хоткей всё ещё работает.",
                    file=sys.stderr,
                )

        threading.Thread(
            target=run_tray,
            name="snipcast-tray",
            daemon=not is_darwin,
        ).start()

    app.after(400, start_tray)
    app.mainloop()


def main() -> None:
    if platform.system() == "Darwin":
        if _env_truthy("SNIPCAST_USE_TK"):
            _main_tk()
        else:
            _main_darwin_qt()
        return
    _main_tk()


if __name__ == "__main__":
    main()
