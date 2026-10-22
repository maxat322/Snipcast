# Совместное скрытие панелей при рисовании

При пересечении курсором основной панели или открытых настроек во время рисования, перемещения фигуры, изменения её точки либо текстового жеста скрывается весь блок панелей. После выхода курсора, отпускания мыши, Escape, отмены указателя или потери фокуса панели возвращаются. Без активного жеста кнопки и настройки остаются доступны.

Изменены только `src/capture/CaptureOverlay.tsx`, `tests/capture_area_annotations.py`, `tests/pin_annotation.py`. Существующие изменения других задач сохранены.

Проверки выбраны через `test:changed -- --list --files`, затем запущен тот же список: базовый захват, аннотации области, аннотации закрепа. Проверяются обе темы, масштабирование, прохождение рисунка через обе панели, отсутствие перехвата указателя, сохранение геометрии и восстановление видимости.

Доказательства: [план](qa-artifacts/grouped-toolbar-hide/test-plan.txt), [результаты захвата](qa-artifacts/grouped-toolbar-hide/capture-results.json), [скрытие обеих панелей](qa-artifacts/grouped-toolbar-hide/drawing-through-options.png), [лог проверок](qa-artifacts/grouped-toolbar-hide/tests.txt), [сборка](qa-artifacts/grouped-toolbar-hide/build.txt), [EXE](qa-artifacts/grouped-toolbar-hide/artifact.json), [запуск](qa-artifacts/grouped-toolbar-hide/runtime.json), [очистка](qa-artifacts/grouped-toolbar-hide/cleanup.json).
