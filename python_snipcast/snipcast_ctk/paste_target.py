"""Цель вставки и Cmd+V / Ctrl+V — зеркало src-tauri/src/paste_target.rs."""

from __future__ import annotations

import os
import platform
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

_last_foreign_pid: Optional[int] = None
_last_win_hwnd: Optional[int] = None


@dataclass
class PasteTarget:
    macos_pid: Optional[int] = None
    win_hwnd: Optional[int] = None


def _macos_frontmost_pid() -> Optional[int]:
    try:
        out = subprocess.run(
            [
                "osascript",
                "-e",
                'tell application "System Events" to unix id of first application process whose frontmost is true',
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode != 0:
            return None
        s = out.stdout.strip()
        return int(s) if s else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _macos_activate_and_paste_cmd_v(pid: int) -> None:
    script = f"""tell application "System Events"
  tell (first application process whose unix id is {pid})
    set frontmost to true
    delay 0.55
    keystroke "v" using command down
  end tell
end tell"""
    out = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if out.returncode != 0 and out.stderr:
        print(f"[snipcast] osascript stderr: {out.stderr}", file=sys.stderr)


def refresh_paste_target() -> PasteTarget:
    """Вызывать с главного потока перед показом палитры и перед вставкой."""
    global _last_foreign_pid, _last_win_hwnd
    ours = os.getpid()
    system = platform.system()

    if system == "Darwin":
        front = _macos_frontmost_pid()
        if front is not None and front != ours:
            _last_foreign_pid = front
            return PasteTarget(macos_pid=front)
        return PasteTarget(macos_pid=_last_foreign_pid)

    if system == "Windows":
        hwnd = _win_foreground_hwnd_if_other_process()
        if hwnd is not None:
            _last_win_hwnd = hwnd
            return PasteTarget(win_hwnd=hwnd)
        return PasteTarget(win_hwnd=_last_win_hwnd)

    return PasteTarget()


def _win_foreground_hwnd_if_other_process() -> Optional[int]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value == 0 or pid.value == os.getpid():
        return None
    return int(hwnd)


def _win_activate_and_paste_ctrl_v(hwnd: int) -> None:
    import ctypes

    user32 = ctypes.windll.user32
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.2)
    try:
        from pynput.keyboard import Controller, Key

        kb = Controller()
        kb.press(Key.ctrl)
        kb.press("v")
        kb.release("v")
        kb.release(Key.ctrl)
    except Exception as e:
        print(f"[snipcast] paste key simulation: {e}", file=sys.stderr)


def paste_into_previous(target: PasteTarget) -> None:
    system = platform.system()
    if system not in ("Darwin", "Windows"):
        return
    if system == "Darwin":
        if target.macos_pid is not None:
            _macos_activate_and_paste_cmd_v(target.macos_pid)
        else:
            print(
                "[snipcast] macos_pid отсутствует — не удалось определить приложение для вставки",
                file=sys.stderr,
            )
    elif system == "Windows":
        if target.win_hwnd is not None:
            _win_activate_and_paste_ctrl_v(target.win_hwnd)


def paste_template(text: str, hide_palette: Callable[[], None]) -> None:
    """Копирует в буфер, скрывает окно, через ~220 мс вставляет в предыдущее приложение."""
    text = text.strip()
    if not text:
        return

    import pyperclip

    target = refresh_paste_target()

    try:
        pyperclip.copy(text)
    except Exception as e:
        print(f"[snipcast] clipboard: {e}", file=sys.stderr)
        return

    hide_palette()

    snap = PasteTarget(
        macos_pid=target.macos_pid,
        win_hwnd=target.win_hwnd,
    )

    def worker() -> None:
        time.sleep(0.220)
        paste_into_previous(snap)

    threading.Thread(target=worker, daemon=True).start()
