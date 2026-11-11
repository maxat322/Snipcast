"""Verify actual Windows registrations in an isolated release instance, without input injection."""
import ctypes, json, os, shutil, socket, subprocess, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work/secondary-native'
OUT.mkdir(parents=True,exist_ok=True)
EXE=ROOT/'.qa-work/secondary-hotkeys-qa.exe'
shutil.copy2(ROOT/'src-tauri/target/release/snipcast.exe',EXE)
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
keys={'paletteHotkey':121,'paletteHotkeySecondary':122,'screenshotHotkey':123,'screenshotHotkeySecondary':124}
config={'autostart':False,'screenshotPresets':[],'screenshotPresetDefaultsVersion':1,'textSuggestions':{'enabled':False,'toggleHotkey':''}}
config.update({field:f'Control+Alt+Shift+F{vk-111}' for field,vk in keys.items()})
(OUT/'config.json').write_text(json.dumps(config),encoding='utf-8')
env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={port}'}
u=ctypes.windll.user32
results=[]
proc=None
log=(OUT/'process.log').open('w',encoding='utf-8')
def free(vk):
 ok=bool(u.RegisterHotKey(None,9281,7,vk))
 if ok:u.UnregisterHotKey(None,9281)
 return ok
assert all(free(vk) for vk in keys.values()),'QA keys are already in use'
def wait(fn):
 end=time.monotonic()+25
 while time.monotonic()<end:
  try:
   result=fn()
   if result:return result
  except (OSError,ValueError):pass
  time.sleep(.1)
 raise AssertionError('Native QA timed out')
def endpoints():
 if proc.poll() is not None:raise AssertionError(f'QA exited {proc.returncode}')
 return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=.5))
def start(p):
 global proc
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 wait(lambda:any('tauri.localhost' in item.get('url','') for item in endpoints()))
 browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
 page=wait(lambda:next((page for page in browser.contexts[0].pages if 'snipcast=' not in page.url and 'tauri.localhost' in page.url),None))
 page.wait_for_load_state('networkidle')
 return browser,page
def call(page,cmd,**args):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args])
def stop(browser,page):
 try:call(page,'snipcast_commands_run',id='quit')
 except Exception:pass
 proc.wait(timeout=15);browser.close()
try:
 with sync_playwright() as p:
  browser,page=start(p)
  assert all(not free(vk) for vk in keys.values()),'Both keyboard shortcuts must be registered'
  results.append('four keyboard bindings registered at startup')
  for name in ('palette','screenshot'):
   fields=[name+'Hotkey',name+'HotkeySecondary']
   call(page,f'snipcast_{name}_hotkey_pause')
   assert all(free(keys[field]) for field in fields)
   call(page,f'snipcast_{name}_hotkey_resume')
   assert all(not free(keys[field]) for field in fields)
  results.append('pause and resume affect both bindings in each group')
  snapshot=call(page,'snipcast_get_config')
  for field in ('paletteHotkeySecondary','screenshotHotkeySecondary'):
   incoming={**snapshot,field:snapshot['paletteHotkey']}
   try:call(page,'snipcast_save_config',incoming=incoming)
   except Exception:pass
   else:raise AssertionError('Duplicate shortcut accepted')
   assert call(page,'snipcast_get_config')[field]==snapshot[field]
  assert u.RegisterHotKey(None,9282,7,125)
  try:
   incoming={**snapshot,'paletteHotkeySecondary':'Control+Alt+Shift+F14'}
   try:call(page,'snipcast_save_config',incoming=incoming)
   except Exception:pass
   else:raise AssertionError('Occupied OS shortcut accepted')
   assert call(page,'snipcast_get_config')['paletteHotkeySecondary']==snapshot['paletteHotkeySecondary']
   assert not free(keys['paletteHotkeySecondary'])
  finally:u.UnregisterHotKey(None,9282)
  call(page,'snipcast_palette_hotkey_pause')
  assert u.RegisterHotKey(None,9282,7,125)
  try:
   incoming={**snapshot,'paletteHotkeySecondary':'Control+Alt+Shift+F14'}
   try:call(page,'snipcast_save_config',incoming=incoming,skipPaletteHotkeyApply=True)
   except Exception:pass
   else:raise AssertionError('Occupied OS shortcut accepted during recording')
   assert call(page,'snipcast_get_config')['paletteHotkeySecondary']==snapshot['paletteHotkeySecondary']
  finally:
   u.UnregisterHotKey(None,9282)
   call(page,'snipcast_palette_hotkey_resume')
  assert not free(keys['paletteHotkeySecondary'])
  results.append('duplicates and OS registration failures preserve prior config and binding')
  incoming={**snapshot,'paletteHotkeySecondary':'','screenshotHotkeySecondary':'Alt+Mouse4'}
  call(page,'snipcast_save_config',incoming=incoming)
  assert free(keys['paletteHotkeySecondary']) and free(keys['screenshotHotkeySecondary'])
  assert not free(keys['paletteHotkey']) and not free(keys['screenshotHotkey'])
  results.append('clear and mouse replacement release only secondary keyboard bindings')
  stop(browser,page)
  browser,page=start(p)
  restored=call(page,'snipcast_get_config')
  assert restored['paletteHotkeySecondary']=='' and restored['screenshotHotkeySecondary']=='Alt+Mouse4'
  assert not free(keys['paletteHotkey']) and not free(keys['screenshotHotkey'])
  results.append('secondary mouse binding persists across process restart; primaries remain registered')
  stop(browser,page)
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=15)
 log.close()
(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps(results))
