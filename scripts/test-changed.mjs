import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";

const args=process.argv.slice(2),list=args.includes("--list"),native=args.includes("--native"),fullVideo=args.includes("--full-video");
const git=(...args)=>{const result=spawnSync("git",args,{encoding:"utf8"});if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim();};
const values=flag=>{const index=args.indexOf(flag);if(index<0)return [];return args.slice(index+1).filter((_,i,array)=>!array.slice(0,i+1).some(value=>value.startsWith("--")));};
const explicit=values("--files");
const focus=values("--focus")[0];
if(focus&&!['capture-ocr','capture-cursor','capture-toolbar','capture-editor','settings-hotkeys','mouse-hotkeys','template-groups','text-suggestions','commands','commands-keyboard','commands-opening','commands-settings','unified-palette','palette-behavior'].includes(focus))throw new Error(`Unknown test focus: ${focus}`);
const base=values("--base")[0]??git("tag","--sort=-version:refname").split(/\r?\n/)[0]??"HEAD";
let files=explicit.length?explicit:[...git("diff","--name-only","--no-renames",base||"HEAD","--").split(/\r?\n/),...git("ls-files","--others","--exclude-standard").split(/\r?\n/)];
files=[...new Set(files.filter(Boolean).map(file=>file.replaceAll("\\","/")))];
if(!explicit.length)files=files.filter(file=>/^(src\/|src-tauri\/(src\/|native\/|vendor\/wcap\/)|tests\/(capture_0366|capture_toolbar_ui|capture_area_annotations|capture_history_native|pin_annotation|video_editor_ui)\.py$)/.test(file)).filter(file=>{
  if(!existsSync(file))return true;
  // Release snapshots can contain files still untracked in the current checkout.
  // Compare their actual contents, so unchanged old work does not select tests.
  const old=spawnSync("git",["rev-parse",`${base||"HEAD"}:${file}`],{encoding:"utf8"});
  return old.status!==0||old.stdout.trim()!==git("hash-object","--",file);
});
const selected=new Map();
const add=(name,command,args)=>selected.set(name,{command,args});
const testPython=process.env.SNIPCAST_TEST_PYTHON??"python";
const browser=(name,file)=>add(name,testPython,["-B","tests/run_browser.py",file]);
const rust=(filter)=>add(`Rust: ${filter}`,"cargo",["test","--release","--lib","--features","tauri/custom-protocol","--manifest-path","src-tauri/Cargo.toml",filter]);
for(const file of files){
  if(focus==="settings-hotkeys"){
    if(native&&file==="tests/settings_secondary_native.py")add("Настройки: две нативные привязки и перезапуск",testPython,["-B","tests/settings_secondary_native.py"]);
    if(/^src\/Settings|^src\/components\/(CaptureActionHotkeyField|ClearHotkeyButton|SecondaryHotkey)\.tsx$|^tests\/settings_hotkeys_ui\.py$/.test(file))browser("Настройки: запись, второе сочетание, очистка и сброс","tests/settings_hotkeys_ui.py");
    if(file==="src-tauri/src/lib.rs")rust("capture_hotkey_tests");
    if(file==="src-tauri/src/data.rs")rust("data::tests");
    if(file==="src-tauri/src/mouse_hotkeys.rs")rust("mouse_hotkeys::");
    if(file==="src-tauri/src/text_suggestions.rs")rust("text_suggestions::tests");
    if(file==="src-tauri/src/commands/mod.rs")rust("commands::tests");
    continue;
  }

  if(focus==="palette-behavior"){
    if(file==="tests/unified_palette_ui.py"||file==="src/App.tsx")browser("Палитра: встроенный и прямой запуск, поиск скриншота", "tests/unified_palette_ui.py");
    if(file==="tests/commands_opening_ui.py"||file==="src/commands/CommandsApp.tsx")browser("Инструменты: прямое открытие и готовность", "tests/commands_opening_ui.py");
    if(file==="src-tauri/src/commands/mod.rs")rust("commands::tests");
    if(native&&file==="tests/unified_palette_native.py")add("Палитры: отдельный инструмент и снимок без скрытия",testPython,["-B","tests/unified_palette_native.py"]);
    continue;
  }
  if(focus==="mouse-hotkeys"){
    if(file==="tests/mouse_hotkeys_ui.py"||/^src\//.test(file))browser("Сочетания мыши: запись и сохранение", "tests/mouse_hotkeys_ui.py");
    if(/^src-tauri\/src\/(mouse_hotkeys|lib|commands\/mod|text_suggestions|capture_keyboard)\.rs$/.test(file))rust("mouse_hotkeys::");
    if(native&&file==="tests/mouse_hotkeys_native.py")add("Сочетания мыши: нативная обработка",testPython,["-B","tests/mouse_hotkeys_native.py"]);
    continue;
  }
  if(focus==="capture-ocr"){
    if(file==="src/capture/CaptureOverlay.tsx"||file==="tests/capture_history_ocr_ui.py")browser("OCR: источник истории, масштаб и возврат к захвату","tests/capture_history_ocr_ui.py");
    if(file==="src-tauri/src/screenshot.rs")rust("ocr_crop");
    if(native&&file==="tests/capture_history_ocr_native.py")add("OCR: сохранённое изображение в WebView2",testPython,["-B","tests/capture_history_ocr_native.py"]);
    continue;
  }
  if(focus==="unified-palette"){
    if(/^src\/(App\.tsx|SettingsApp\.tsx|commands\/model\.ts)/.test(file)||file==="tests/unified_palette_ui.py")browser("Объединённая палитра: шаблоны, команды и приложения", "tests/unified_palette_ui.py");
    if(native&&file==="tests/unified_palette_native.py")add("Объединённая палитра: нативные сценарии",testPython,["-B","tests/unified_palette_native.py"]);
    if(native&&/^src-tauri\/src\/(commands\/mod|lib)\.rs$/.test(file))rust("commands::");
    continue;
  }
  if(focus==="commands-settings"){
    if(/^src\/(commands\/CommandsSettings|SettingsApp)/.test(file)||file==="tests/commands_settings_task_ui.py")browser("Настройки команд: навигация и горячая клавиша", "tests/commands_settings_task_ui.py");
    if(native&&file==="tests/commands_settings_task_native.py")add("Настройки команд: нативное окно",testPython,["-B","tests/commands_settings_task_native.py"]);
    continue;
  }
  if(focus==="commands-opening"){
    if(native&&file==="tests/emoji_popular_native.py")add("Emoji: популярные и все в нативном окне",testPython,["-B","tests/emoji_popular_native.py"]);
    if(native&&file==="tests/emoji_categories_native.py")add("Emoji: меню категорий в нативном окне",testPython,["-B","tests/emoji_categories_native.py"]);
    if(/^src\/commands\//.test(file)||file==="tests/commands_opening_ui.py"){
      browser("Команды: прямое открытие, Emoji, конкурирующая загрузка истории","tests/commands_opening_ui.py");
      browser("Команды: регрессия Esc/Enter","tests/commands_keyboard_ui.py");
      browser("Команды: поиск, действия и настройки","tests/commands_ui.py");
    }
    if(native&&file==="tests/commands_dismiss_native.py")add("Команды: нативное закрытие по Esc и клику вне окна",testPython,["-B","tests/commands_dismiss_native.py"]);
    if(native&&file==="tests/commands_opening_native.py")add("Команды: прямые горячие клавиши и скорость открытия",testPython,["-B","tests/commands_opening_native.py"]);
    if(native&&/^src-tauri\/src\/commands\//.test(file))rust("commands::");
    continue;
  }
  if(focus==="commands-keyboard"){
    if(native&&file==="tests/emoji_arrows_native.py")add("Emoji: навигация в нативном WebView",testPython,["-B","tests/emoji_arrows_native.py"]);
    if(file==="src/commands/CommandsApp.tsx"||file==="tests/commands_keyboard_ui.py")browser("Команды: Esc/Enter при потере фокуса и повторном открытии","tests/commands_keyboard_ui.py");
    if(native&&file==="tests/commands_keyboard_native.py")add("Команды: нативные Esc/Enter, буфер и Emoji",testPython,["-B","tests/commands_keyboard_native.py"]);
    continue;
  }
  if(focus==="commands"){
    if(/^src\//.test(file)||file==="tests/commands_ui.py")browser("Палитра команд: интерфейс и настройки","tests/commands_ui.py");
    if(/^src-tauri\/src\/commands\//.test(file))rust("commands::");
    if(file==="src-tauri/src/data.rs")rust("data::tests");
    if(file==="src-tauri/src/lib.rs")rust("capture_hotkey_tests");
    if(file==="src-tauri/src/capture_keyboard.rs")rust("capture_keyboard::tests");
    if(native&&file==="tests/commands_native.py")add("Палитра команд: нативный буфер и вставка",testPython,["-B","tests/commands_native.py"]);
    if(native&&(file==="tests/commands_acceptance.py"||file==="tests/native_keys.py"))add("Палитры: совпадение оформления и нативный Alt+Space",testPython,["-B","tests/commands_acceptance.py"]);
    if(native&&(file==="tests/commands_e2e.py"||file==="tests/native_keys.py"))add("Палитра команд: E2E пользовательских сценариев",testPython,["-B","tests/commands_e2e.py"]);
    continue;
  }

  if(focus==="capture-cursor"){
    if(/^src\/capture\/|^tests\/capture_cursor\.py$/.test(file))browser("Захват: системный курсор, экспорт и сброс сессии","tests/capture_cursor.py");
    if(/^src-tauri\/src\/(screenshot|capture_cursor|capture_history)\.rs$/.test(file))rust("screenshot::capture_cursor::tests");
    if(file==="src-tauri/src/capture_keyboard.rs")rust("capture_keyboard::tests");
    continue;
  }
  if(focus==="text-suggestions"){
    if(file==="tests/text_suggestions_native.py"&&native)add("Подсказки: нативный ввод, фокус и замена",testPython,["-B","tests/text_suggestions_native.py",...(process.env.SNIPCAST_INLINE_QA_QUICK==="1"?["--quick"]:[])]);
    if(/^src\//.test(file)||file==="tests/text_suggestions_ui.py")browser("Подсказки: настройки, плашка, форма и отмена","tests/text_suggestions_ui.py");
    if(file==="src-tauri/src/text_suggestions.rs")rust("text_suggestions::tests");
    if(file==="src-tauri/src/suggestions_windows.rs"){rust("suggestions_windows::tests");if(native)add("Подсказки: нативный ввод, фокус и замена",testPython,["-B","tests/text_suggestions_native.py"]);}
    if(file==="src-tauri/src/data.rs")rust("data::tests");
    if(file==="src-tauri/src/paste_target.rs")rust("paste_target::win::tests");
    if(file==="src-tauri/src/lib.rs")rust("capture_hotkey_tests");
    if(file==="src/SettingsApp.tsx"||file==="src/components/CaptureActionHotkeyField.tsx")browser("Настройки: регрессия горячих клавиш","tests/settings_hotkeys_ui.py");
    continue;
  }
  if(/^src\/commands\//.test(file)||file==="tests/commands_ui.py")browser("Палитра команд: интерфейс и настройки","tests/commands_ui.py");
  if(/^src-tauri\/src\/commands\//.test(file)){rust("commands::");if(native)add("Палитра команд: нативный буфер и вставка",testPython,["-B","tests/commands_native.py"]);}
  if(file==="tests/commands_native.py"&&native)add("Палитра команд: нативный буфер и вставка",testPython,["-B","tests/commands_native.py"]);
  if(file==="tests/commands_e2e.py"&&native)add("Палитра команд: E2E пользовательских сценариев",testPython,["-B","tests/commands_e2e.py"]);
  if(/^src\/suggestions\//.test(file)||file==="tests/text_suggestions_ui.py")browser("Подсказки: настройки, плашка, форма и отмена","tests/text_suggestions_ui.py");
  if(file==="src-tauri/src/text_suggestions.rs")rust("text_suggestions::tests");
  if(file==="src-tauri/src/suggestions_windows.rs"){rust("suggestions_windows::tests");if(native)add("Подсказки: нативный ввод, фокус и замена",testPython,["-B","tests/text_suggestions_native.py"]);}
  if(focus==="template-groups"){
    if(/^src\/Settings|^src\/components\/TemplateGroupTabs\.tsx$|^tests\/template_groups_ui\.py$/.test(file))browser("Шаблоны: перетаскивание групп и автосохранение","tests/template_groups_ui.py");
    continue;
  }
  if(focus==="capture-editor"){
    if(/^src\/capture\/|^src\/Settings|^src\/capture\.css$|^tests\/capture_0368_ui\.py$/.test(file))browser("Захват: возврат подсказок, заливка, прозрачность, настройки","tests/capture_0368_ui.py");
    if(file==="src-tauri/src/capture_keyboard.rs"){rust("capture_keyboard::tests");if(native)add("Перехват: конфликт сочетаний, текст, фокус, диалог","python",["-B","tests/capture_0368_native.py"]);}
    continue;
  }
  if(focus==="capture-toolbar"){
    if(/^src\/capture\/|^src\/capture\.css$|^tests\/capture_toolbar_ui\.py$/.test(file)){
      browser("Захват: подсказки и один ряд цветов","tests/capture_toolbar_ui.py");
      if(native)add("Нативное окно: подсказки и цвета","python",["-B","tests/capture_0366_native.py","--toolbar-only"]);
    }
    continue;
  }
  if(file==="tests/capture_toolbar_ui.py")browser("Захват: подсказки и один ряд цветов","tests/capture_toolbar_ui.py");
  if(/^src\/capture\/|^tests\/capture_cursor\.py$/.test(file))browser("Захват: системный курсор, экспорт и сброс сессии","tests/capture_cursor.py");
  if(file==="src-tauri/src/capture_cursor.rs")rust("screenshot::capture_cursor::tests");
  if(/^src\/capture\/|^src\/capture\.css$|^tests\/capture_0366\.py$/.test(file))browser("Захват: направляющие, история, цвета, Shift","tests/capture_0366.py");
  if(/^src\/capture\/|^src\/capture\.css$|^tests\/capture_area_annotations\.py$/.test(file))browser("Захват: курсор, очистка, редактируемая история и панели","tests/capture_area_annotations.py");
  if(/^src\/capture\/|^src\/capture\.css$|^tests\/pin_annotation\.py$/.test(file))browser("Аннотации закрепа","tests/pin_annotation.py");
  if(/^src\/video\/|^tests\/video_editor_ui\.py$/.test(file))browser("Видео: только интерфейс редактора","tests/video_editor_ui.py");
  if(file==="src/components/useQuickSaveHover.ts"){
    browser("Захват: направляющие, история, цвета, Shift","tests/capture_0366.py");
    browser("Аннотации закрепа","tests/pin_annotation.py");
    browser("Видео: только интерфейс редактора","tests/video_editor_ui.py");
  }
  if(/^src\/SettingsApp\.tsx$|CaptureActionHotkeyField|actionHotkeys|^src\/hotkeyFormat\.ts$/.test(file))browser("Захват: направляющие, история, цвета, Shift","tests/capture_0366.py");
  if(file==="src-tauri/src/data.rs")rust("data::tests");
  if(file==="src-tauri/src/lib.rs")rust("capture_hotkey_tests");
  if(file==="src-tauri/src/capture_detection.rs")rust("capture_detection::tests");
  if(file==="src-tauri/src/capture_keyboard.rs")rust("capture_keyboard::tests");
  if(native&&(file==="src-tauri/src/capture_keyboard.rs"||file==="tests/capture_text_language_native.py"))add("Текст захвата: системная раскладка WebView2",testPython,["-B","tests/capture_text_language_native.py"]);
  if(file==="src-tauri/src/screenshot.rs")rust("screenshot::tests");
  if(/^src-tauri\/(src\/video\.rs|native\/video\.c|vendor\/wcap\/)/.test(file)){
    rust("video::tests");if(native)add("Нативная запись и экспорт видео","python",["-B","tests/video_native.py","changed-backend"]);
  }
  if(native&&(file==="src-tauri/src/capture_history.rs"||file==="tests/capture_history_native.py"))add("Нативная история аннотаций",testPython,["-B","tests/capture_history_native.py"]);
  if(native&&/^src-tauri\/src\/(data|screenshot)\.rs$/.test(file))add("Нативный захват и история","python",["-B","tests/capture_0366_native.py"]);
}
if(fullVideo)add("Полный прогон видео (явно запрошен)","python",["-B","tests/video_native.py","explicit-full"]);
console.log(`База сравнения: ${explicit.length?"явно перечисленные файлы":base||"HEAD"}`);
console.log(`Выбрано проверок: ${selected.size}`);
for(const [name,run] of selected){
  console.log(`${list?"План":"Проверка"}: ${name}`);
  if(list)continue;
  const result=spawnSync(run.command,run.args,{stdio:"inherit",env:{...process.env,PYTHONUTF8:"1",STATIC_VCRUNTIME:"true"}});
  if(result.error){console.error(result.error.message);process.exitCode=1;break;}
  if(result.status!==0){process.exitCode=result.status??1;break;}
}
