import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";

const args=process.argv.slice(2),list=args.includes("--list"),native=args.includes("--native"),fullVideo=args.includes("--full-video");
const git=(...args)=>{const result=spawnSync("git",args,{encoding:"utf8"});if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim();};
const values=flag=>{const index=args.indexOf(flag);if(index<0)return [];return args.slice(index+1).filter((_,i,array)=>!array.slice(0,i+1).some(value=>value.startsWith("--")));};
const explicit=values("--files");
const focus=values("--focus")[0];
if(focus&&!['capture-toolbar','capture-editor','settings-hotkeys','template-groups','text-suggestions'].includes(focus))throw new Error(`Unknown test focus: ${focus}`);
const base=values("--base")[0]??git("tag","--sort=-version:refname").split(/\r?\n/)[0]??"HEAD";
let files=explicit.length?explicit:[...git("diff","--name-only","--no-renames",base||"HEAD","--").split(/\r?\n/),...git("ls-files","--others","--exclude-standard").split(/\r?\n/)];
files=[...new Set(files.filter(Boolean).map(file=>file.replaceAll("\\","/")))];
if(!explicit.length)files=files.filter(file=>/^(src\/|src-tauri\/(src\/|native\/|vendor\/wcap\/)|tests\/(capture_0366|capture_toolbar_ui|pin_annotation|video_editor_ui)\.py$)/.test(file)).filter(file=>{
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
  if(/^src\/suggestions\//.test(file)||file==="tests/text_suggestions_ui.py")browser("Подсказки: настройки, плашка, форма и отмена","tests/text_suggestions_ui.py");
  if(file==="src-tauri/src/text_suggestions.rs")rust("text_suggestions::tests");
  if(file==="src-tauri/src/suggestions_windows.rs"){rust("suggestions_windows::tests");if(native)add("Подсказки: нативный ввод, фокус и замена",testPython,["-B","tests/text_suggestions_native.py"]);}
  if(focus==="template-groups"){
    if(/^src\/Settings|^src\/components\/TemplateGroupTabs\.tsx$|^tests\/template_groups_ui\.py$/.test(file))browser("Шаблоны: перетаскивание групп и автосохранение","tests/template_groups_ui.py");
    continue;
  }
  if(focus==="settings-hotkeys"){
    if(/^src\/Settings|^src\/components\/(CaptureActionHotkeyField|ClearHotkeyButton)\.tsx$|^tests\/settings_hotkeys_ui\.py$/.test(file))browser("Настройки: подписи, очистка и возврат горячих клавиш","tests/settings_hotkeys_ui.py");
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
  if(/^src\/capture\/|^src\/capture\.css$|^tests\/capture_0366\.py$/.test(file))browser("Захват: направляющие, история, цвета, Shift","tests/capture_0366.py");
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
  if(file==="src-tauri/src/screenshot.rs")rust("screenshot::tests");
  if(/^src-tauri\/(src\/video\.rs|native\/video\.c|vendor\/wcap\/)/.test(file)){
    rust("video::tests");if(native)add("Нативная запись и экспорт видео","python",["-B","tests/video_native.py","changed-backend"]);
  }
  if(native&&/^src-tauri\/src\/(capture_history|data|screenshot)\.rs$/.test(file))add("Нативный захват и история","python",["-B","tests/capture_0366_native.py"]);
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
