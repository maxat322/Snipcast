# Snipcast 0.36.10 — крестик очистки

Иконка пяти кнопок очистки горячих клавиш заменена на крестик. Сохранены доступные названия, подсказки и состояния кнопок.

Проверки выбраны по файлам текущей задачи через `test:changed --list --files … --focus settings-hotkeys`, затем выполнена та же команда без `--list`. Запущена только проверка настроек. Браузерный тест с имитацией Tauri IPC прошёл в обеих темах при ширине 950/720 px; изображение крестика дополнительно проверено визуально. Захват, запись видео и нативный перехват клавиатуры не тестировались.

Подтверждения: [выбор проверок](qa-artifacts/settings-hotkeys-03610/test-selection.log), [результаты](qa-artifacts/settings-hotkeys-03610/results.json), [лог](qa-artifacts/settings-hotkeys-03610/settings-tests.log), [тёмная тема](qa-artifacts/settings-hotkeys-03610/dark-950.png), [светлая тема](qa-artifacts/settings-hotkeys-03610/light-950.png).

Release-сборка `npm run tauri build -- --no-bundle` прошла успешно. В `dist-release/` находятся только актуальный EXE 0.36.10 и SHA-256. [Лог сборки](qa-artifacts/settings-hotkeys-03610/build-03610.log).

Предыдущая версия штатно закрыта через «Выход» в трее после проверки отсутствия видимой работы. После очистки запущена 0.36.10; проверены путь `dist-release/snipcast.exe`, версия и готовность нативного трея. [Запуск](qa-artifacts/settings-hotkeys-03610/launched.json).

`cargo clean` удалил 4820 файлов / 2.1 GiB. Также удалены промежуточный frontend `dist/`, `.qa-work/`, `.vite/` и `.vite-temp/`. Всего освобождено около 2.13 GiB; пользовательские данные не затрагивались. [Аудит до очистки](qa-artifacts/settings-hotkeys-03610/cleanup-before.json), [после](qa-artifacts/settings-hotkeys-03610/cleanup-after.json). GitHub-релиз не публиковался.
