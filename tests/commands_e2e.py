"""Native command palette acceptance against an isolated QA identifier/data directory."""
import ctypes,json,os,subprocess,time,urllib.request,struct,io,base64,sqlite3,sys
from pathlib import Path
from ctypes import wintypes as W
from PIL import Image
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work/commands-e2e'/str(time.time_ns());OUT.mkdir(parents=True,exist_ok=True)
EXE=Path(os.environ.get('SNIPCAST_COMMANDS_QA_EXE',str(ROOT/'.qa-work/commands-qa.exe')));PORT=9289
u=ctypes.windll.user32;k=ctypes.windll.kernel32
u.OpenClipboard.argtypes=[W.HWND];u.GetClipboardData.argtypes=[W.UINT];u.GetClipboardData.restype=W.HANDLE;u.SetClipboardData.argtypes=[W.UINT,W.HANDLE];u.SetClipboardData.restype=W.HANDLE
k.GlobalAlloc.argtypes=[W.UINT,ctypes.c_size_t];k.GlobalAlloc.restype=W.HGLOBAL;k.GlobalLock.argtypes=[W.HGLOBAL];k.GlobalLock.restype=ctypes.c_void_p;k.GlobalUnlock.argtypes=[W.HGLOBAL];k.GlobalSize.argtypes=[W.HGLOBAL];k.GlobalSize.restype=ctypes.c_size_t
u.GetForegroundWindow.restype=W.HWND;u.SetForegroundWindow.argtypes=[W.HWND];u.RegisterClipboardFormatW.argtypes=[W.LPCWSTR];u.RegisterClipboardFormatW.restype=W.UINT
fixture=subprocess.Popen([sys.executable,"-B",str(ROOT/'tests/commands_target.py'),str(OUT)],creationflags=0x08000000)
def target_state():
 try:return json.loads((OUT/'target-state.json').read_text(encoding='utf8'))
 except (OSError,ValueError):return {}
deadline=time.monotonic()+10
while not target_state():
 if time.monotonic()>deadline:raise RuntimeError('Native editor fixture unavailable')
 time.sleep(.05)
hwnd=target_state()['hwnd']
def target_action(action):
 id=time.time_ns();temp=OUT/'target-command.tmp';temp.write_text(json.dumps({'id':id,'action':action}),encoding='utf8');
 deadline=time.monotonic()+2
 while True:
  try:temp.replace(OUT/'target-command.json');break
  except PermissionError:
   if time.monotonic()>deadline:raise
   time.sleep(.02)
 deadline=time.monotonic()+5
 while target_state().get('id')!=id:
  if action=='close' and fixture.poll() is not None:return
  if time.monotonic()>deadline:raise RuntimeError('Fixture did not respond: '+action)
  time.sleep(.03)
class Window:
 def update(self):pass
 def lift(self):target_action('focus')
 def destroy(self):
  try:target_action('close')
  except RuntimeError:pass
  finally:
   if fixture.poll() is None:fixture.terminate()
 def deiconify(self):pass
class Editor:
 def delete(self,*args):target_action('clear')
 def focus_force(self):target_action('focus')
 def get(self,*args):return target_state().get('text','')
window=Window();editor=Editor()
def opening():
 for _ in range(30):
  if u.OpenClipboard(hwnd):return
  time.sleep(.02)
 raise RuntimeError('Clipboard busy')
def read_formats():
 opening();result={}
 try:
  fmt=0
  while True:
   fmt=u.EnumClipboardFormats(fmt)
   if not fmt:break
   if fmt not in [13,15,8,17,u.RegisterClipboardFormatW("HTML Format"),u.RegisterClipboardFormatW("Rich Text Format"),u.RegisterClipboardFormatW("PNG")]:continue
   h=u.GetClipboardData(fmt);n=k.GlobalSize(h)
   if h and 0<n<32*1024*1024:
    ptr=k.GlobalLock(h)
    if ptr:result[fmt]=ctypes.string_at(ptr,n);k.GlobalUnlock(h)
 finally:u.CloseClipboard()
 return result
saved_clip=read_formats()
(OUT/'clipboard-backup.json').write_text(json.dumps({str(k):base64.b64encode(v).decode() for k,v in saved_clip.items()}),encoding='utf8')
def write_formats(data):
 opening()
 try:
  u.EmptyClipboard()
  for fmt,b in data.items():
   h=k.GlobalAlloc(2,len(b));ptr=k.GlobalLock(h);ctypes.memmove(ptr,b,len(b));k.GlobalUnlock(h);assert u.SetClipboardData(fmt,h)
 finally:u.CloseClipboard()
def wait(fn,timeout=12):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  window.update()
  value=fn()
  if value:return value
  time.sleep(.08)
 raise AssertionError('Timed out waiting for native condition')
config={'autostart':False,'paletteHotkey':'','screenshotHotkey':'','screenshotPresets':[],'screenshotPresetDefaultsVersion':1,'textSuggestions':{'enabled':False,'toggleHotkey':''},'commands':{'hotkey':'Control+Alt+Shift+F10','items':{'clipboard':{'enabled':True,'alias':'','hotkey':'Control+Alt+Shift+F9'},'emoji':{'enabled':True,'alias':'','hotkey':'Control+Alt+Shift+F8'},'translate':{'enabled':True,'alias':'','hotkey':'Control+Alt+Shift+F7'}},'clipboardEnabled':True,'retentionDays':30,'storageMb':32,'excludedApps':[]}}
apps=OUT/'apps';apps.mkdir();marker_file=OUT/'launched.txt'
launch_script=OUT/'launch.ps1';launch_script.write_text(f"'launched' | Set-Content -LiteralPath '{marker_file}'",encoding='utf8')
ps=f'''$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{apps}/Snipcast QA Launcher.lnk');$s.TargetPath="$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";$s.Arguments='-NoProfile -WindowStyle Hidden -File "{launch_script}"';$s.WindowStyle=7;$s.Save()'''
subprocess.run(['powershell.exe','-NoProfile','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],check=True,creationflags=0x08000000)
config['commands']['folders']=[str(apps)]
(OUT/'config.json').write_text(json.dumps(config),encoding='utf8')
log=(OUT/'process.log').open('w',encoding='utf8');proc=None
import faulthandler
stacklog=(OUT/'stacks.log').open('w')
faulthandler.dump_traceback_later(60,repeat=True,file=stacklog)
results=[];errors=[]
try:
 env={**os.environ,'SNIPCAST_QA_INPUT':'1','SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 def endpoint():
  if proc.poll() is not None:raise RuntimeError('QA process exited')
  try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
  except OSError:return None
 wait(endpoint,30)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
  page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None))
  page.wait_for_load_state('networkidle');page.set_default_timeout(3500);page.on('pageerror',lambda e:errors.append(str(e)))
  def call(cmd,**args):return page.evaluate('([c,a])=>Promise.race([window.__TAURI_INTERNALS__.invoke(c,a),new Promise((_,reject)=>setTimeout(()=>reject(Error(c+" IPC timeout")),10000))])',[cmd,args])
  def visible():return call('plugin:window|is_visible',label='commands')
  def native_keys(keys):
   import sys
   subprocess.run([sys.executable,"-B",str(ROOT/'tests/native_keys.py'),*map(str,keys)],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
  def hotkey(vk=0x79):native_keys([0x11,0x12,0x10,vk])
  def root():
   # Fixture reset only. Tested journeys below use controls, not command IPC.
   call('snipcast_commands_hide');window.lift();editor.focus_force();window.update();hotkey();wait(visible);page.wait_for_timeout(150)
   page.get_by_role('textbox',name='Поиск',exact=True).click()
  def search():return page.get_by_role('textbox',name='Поиск',exact=True)
  def section(name):
   root();search().fill(name);page.get_by_role('option',name=name+' Команда').click()
  def action(name):
   page.keyboard.press('Control+j');page.get_by_role('dialog',name='Действия',exact=True).get_by_role('button',name=name,exact=True).click()
  def clip(text):
   write_formats({13:(text+'\0').encode('utf-16le')});wait(lambda:any(c['text']==text for c in call('snipcast_history_list',query='',kind='',offset=0)['items']))
  def clipboard_text():
   b=read_formats().get(13,b'');return b.decode('utf-16le').rstrip('\0')
  def shot(name):page.screenshot(path=str(OUT/(name+'.png')))
  def check(name,fn):
   print('START',name,flush=True)
   try:fn();results.append({'name':name,'passed':True});print('PASS',name,flush=True)
   except Exception as e:
    results.append({'name':name,'passed':False,'error':__import__('traceback').format_exc()});print('FAIL',name,str(e)[:450],flush=True)
    if name.startswith('record Alt+Space'):
     current=call('snipcast_get_config');current['commands']['hotkey']='Control+Alt+Shift+F10';call('snipcast_save_config',incoming=current)
    try:shot('failure-'+str(len(results)))
    except Exception:pass
   (OUT/'result.json').write_text(json.dumps({'checks':results,'pageErrors':errors},ensure_ascii=False,indent=2),encoding='utf8')
  wait(lambda:not call('snipcast_commands_catalog')['scanning'],45)
  def launch_search():
   root();expect(page.get_by_role('option',name='Snipcast QA Launcher Приложение')).to_have_count(0);search().fill('Snipcast QA Launcher');expect(page.locator('[role=option]')).to_have_count(1);shot('01-launcher');search().press('Enter');wait(marker_file.exists);wait(lambda:not visible())
  check('application search and launch through Enter',launch_search)
  def calculator():
   for expression,answer in [('12+11','23'),('((2+3)*6)/2','15'),('-2^2','-4'),('0,1+0,2','0.3')]:
    root();search().fill(expression);expect(page.locator('.commands__calc')).to_contain_text(answer);search().press('Enter');wait(lambda:clipboard_text()==answer);wait(lambda:not visible())
   root();search().fill('1/0');expect(page.locator('.commands__calc')).to_contain_text('ноль');shot('02-calculator-error')
  check('calculator arithmetic, copying and error',calculator)
  def menu_keyboard():
   root();search().fill('7*6');search().press('Control+j');page.get_by_label('Поиск действий').fill('Копировать');page.get_by_label('Поиск действий').press('Enter');wait(lambda:clipboard_text()=='42',4)
  check('filtered actions execute with Enter',menu_keyboard)
  def menu_focus():
   root();search().press('Control+j');page.get_by_label('Поиск действий').press('Escape');page.keyboard.type('emoji');expect(search()).to_have_value('emoji')
  check('focus returns to search after closing actions',menu_focus)
  sample='E2E paragraph\nТекст с пробелами  '
  clip(sample);clip('https://example.com');clip('#f00')
  def history_browse():
   section('Буфер обмена');expect(page.locator('[role=option]').nth(2)).to_be_visible();page.get_by_label('Тип записей').select_option('link');expect(page.locator('[role=option]')).to_have_count(1);expect(page.locator('.commands__preview')).to_contain_text('https://example.com');page.get_by_label('Тип записей').select_option('');search().fill('E2E');expect(page.locator('.commands__preview')).to_contain_text('Текст с пробелами');shot('03-clipboard');search().press('Control+Enter');wait(lambda:clipboard_text()==sample);assert visible()
  check('clipboard search, type filter, preview and Ctrl+Enter',history_browse)
  def pin_rename_focus():
   section('Буфер обмена');search().fill('E2E');expect(page.locator('.commands__preview')).to_contain_text('Текст с пробелами');action('Закрепить');expect(page.locator('.commands__history')).to_contain_text('Закреплённые');action('Переименовать');page.get_by_role('dialog',name='Переименовать запись').get_by_role('textbox').fill('E2E renamed');page.get_by_role('button',name='Сохранить',exact=True).click();expect(page.locator('.commands__history')).to_contain_text('E2E renamed');page.keyboard.press('Control+a');page.keyboard.type('renamed');expect(search()).to_have_value('renamed')
  check('pin, rename and continue searching without mouse',pin_rename_focus)
  def paste_keep():
   editor.delete('1.0','end');section('Буфер обмена');search().fill('E2E');expect(page.locator('.commands__preview')).to_contain_text('Текст с пробелами');action('Вставить и оставить окно');wait(lambda:editor.get('1.0','end-1c')==sample);wait(visible);assert search().evaluate('(e)=>document.activeElement===e')
  check('paste into external editor and keep palette focused',paste_keep)
  def focused_history_enter():
   editor.delete('1.0','end');section('Буфер обмена');search().fill('renamed');expect(page.locator('.commands__content')).to_contain_text('Текст с пробелами');page.locator('[role=option]').first.click();page.keyboard.press('Enter');wait(lambda:editor.get('1.0','end-1c')==sample);wait(lambda:not visible())
  check('Enter on focused clipboard row pastes into external editor',focused_history_enter)
  def image_history():
   image=Image.new('RGB',(84,48),(40,120,210));stream=io.BytesIO();image.save(stream,format='PNG');png=stream.getvalue()
   write_formats({u.RegisterClipboardFormatW('PNG'):png})
   wait(lambda:any(c['kind']=='image' for c in call('snipcast_history_list',query='',kind='',offset=0)['items']))
   section('Буфер обмена');page.get_by_label('Тип записей').select_option('image');expect(page.locator('[role=option]')).to_have_count(1)
   expect(page.locator('.commands__content img')).to_be_visible();shot('clipboard-image');action('Копировать')
   wait(lambda:read_formats().get(u.RegisterClipboardFormatW('PNG')));assert Image.open(io.BytesIO(read_formats()[u.RegisterClipboardFormatW('PNG')])).convert('RGB').tobytes()==image.tobytes()
   page.get_by_role('button',name='Действия',exact=False).click();shot('clipboard-actions');page.get_by_label('Поиск действий').press('Escape')
   action('Удалить запись');expect(page.locator('[role=option]')).to_have_count(0)
  check('image capture, preview, type filter, copy and delete',image_history)
  def plain_text():
   text='E2E rich text';rtf=u.RegisterClipboardFormatW('Rich Text Format')
   write_formats({13:(text+'\0').encode('utf-16le'),rtf:b'{\\rtf1 E2E rich text}\0'})
   wait(lambda:any(c['text']==text for c in call('snipcast_history_list',query='',kind='',offset=0)['items']))
   editor.delete('1.0','end');section('Буфер обмена');search().fill(text);expect(page.locator('.commands__preview')).to_contain_text(text)
   action('Вставить обычным текстом');wait(lambda:editor.get('1.0','end-1c')==text);assert rtf not in read_formats()
  check('rich clipboard pasted as plain text into external editor',plain_text)
  def empty():
   section('Буфер обмена');search().fill('does-not-exist-7432');expect(page.locator('[role=option]')).to_have_count(0);search().press('Enter');assert visible();expect(page.locator('.commands__history')).to_contain_text('История пуста');shot('04-empty')
  check('empty state disables unavailable primary action',empty)
  def emoji_paste():
   editor.delete('1.0','end');section('Emoji');search().fill('улыб');expect(page.locator('[role=option]').first).to_be_visible();search().press('ArrowDown');chosen=page.locator('[aria-selected=true]').inner_text();shot('05-emoji');search().press('Enter');wait(lambda:editor.get('1.0','end-1c')==chosen);wait(lambda:not visible())
   section('Emoji');page.get_by_role('combobox',name='Категория Emoji').click();page.get_by_role('listbox',name='Категория Emoji').get_by_role('option',name='Часто используемые').click();expect(page.locator('[role=option]').first).to_be_visible()
  check('emoji Russian search, keyboard selection, paste and recents',emoji_paste)
  def emoji_caret():
   section('Emoji');search().fill('smile');search().press('ArrowRight');assert page.locator('.commands__emoji [aria-selected=true]').get_attribute('aria-posinset')=='2';search().press('Control+ArrowLeft');assert search().evaluate('(e)=>e.selectionStart')==0
  check('emoji search navigates with arrows and preserves Ctrl+arrow editing',emoji_caret)
  def back_enter():
   section('Emoji');page.get_by_role('button',name='Назад',exact=True).focus();page.keyboard.press('Enter');expect(search()).to_have_attribute('placeholder','Поиск приложений и команд…')
  check('Enter on focused Back button navigates back',back_enter)
  def translator():
   section('Переводчик');text=page.get_by_label('Текст для перевода');expect(text).to_be_focused();text.fill('Hello world');wait(lambda:page.get_by_label('Результат перевода').input_value(),40);translated=page.get_by_label('Результат перевода').input_value();assert translated!='Hello world';text.press('Enter');wait(lambda:clipboard_text()==translated);shot('06-translator')
  check('translator live request after a pause and Enter copies',translator)
  def translator_footer():
   section('Переводчик');expect(page.get_by_label('Текст для перевода')).to_be_visible();footer=page.locator('footer').inner_text().lower();assert 'копировать перевод' in footer and 'пред. перевод' in footer;expect(page.locator('.commands__header .palette__search-icon')).to_be_visible();assert page.get_by_role('textbox',name='Поиск',exact=True).count()==0
  check('translator has relevant header and keyboard hint',translator_footer)
  def reopen():
   section('Emoji');search().fill('smile');page.get_by_label('Категория Emoji').focus();hotkey(0x77);wait(lambda:not visible());hotkey(0x77);wait(visible);expect(search()).to_be_focused();expect(search()).to_have_value('')
  check('direct shortcut reopens same section with input focus',reopen)
  def settings():
   root();action('Настройки команд');global settings_page
   settings_page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=settings' in x.url),None));settings_page.wait_for_load_state('networkidle');settings_page.set_default_timeout(4000)
   expect(settings_page.get_by_role('heading',name='Команды',exact=True,level=2)).to_be_visible()
  check('command settings action opens Commands section',settings)
  def settings_journey():
   print('settings: retention',flush=True);settings_page.get_by_role('button',name='Команды',exact=True).click();settings_page.get_by_role('button',name='Буфер обмена',exact=True).click();settings_page.get_by_label('Хранить историю').select_option('7');wait(lambda:call('snipcast_get_config')['commands']['retentionDays']==7)
   print('settings: emoji',flush=True);settings_page.get_by_role('button',name='Emoji',exact=True).click();settings_page.get_by_label('Колонок').select_option('6');settings_page.get_by_label('Основное действие').select_option('copy');settings_page.get_by_label('Оттенок кожи').select_option('🏽');print('settings: alias',flush=True);settings_page.get_by_label('Псевдоним: Emoji').fill('faces');settings_page.get_by_role('heading',name='Emoji',exact=True,level=2).click();wait(lambda:call('snipcast_get_config')['commands']['items']['emoji']['alias']=='faces')
   settings_page.screenshot(path=str(OUT/'07-settings.png'));root();search().fill('faces');expect(page.get_by_role('option',name='Emoji Команда')).to_be_visible();search().press('Enter');expect(page.locator('.commands__emoji')).to_have_css('grid-template-columns',page.locator('.commands__emoji').evaluate('(e)=>getComputedStyle(e).gridTemplateColumns'));assert len(page.locator('.commands__emoji').evaluate('(e)=>getComputedStyle(e).gridTemplateColumns').split())==6
   search().fill('👍');page.locator('[role=option]').first.click();wait(lambda:clipboard_text()=='👍🏽');wait(lambda:not visible())
  check('settings persistence, alias, emoji columns, skin and copy',settings_journey)
  def focus_settings():
   from pywinauto import Desktop
   call('snipcast_commands_hide');call('plugin:window|show',label='settings');call('plugin:window|set_focus',label='settings')
   native=Desktop(backend='win32').window(process=proc.pid,title='Настройки — Snipcast');native.set_focus();wait(lambda:u.GetForegroundWindow()==native.handle);print('settings hwnd',native.handle,flush=True)
   settings_page.bring_to_front()
  def hotkey_settings():
   focus_settings();settings_page.get_by_role('button',name='Команды',exact=True).click()
   field=settings_page.get_by_label('Горячая клавиша: Палитра команд',exact=True)
   field.click();settings_page.wait_for_timeout(500);native_keys([0x12,0x20])
   wait(lambda:call('snipcast_get_config')['commands']['hotkey']=='Alt+Space')
   settings_page.get_by_role('heading',name='Команды',exact=True,level=2).click()
   call('snipcast_commands_hide');window.lift();editor.focus_force()
   native_keys([0x12,0x20])
   wait(visible);expect(search()).to_be_focused()
   focus_settings();field.click();settings_page.wait_for_timeout(500);native_keys([0x11,0x12,0x10,0x78])
   settings_page.screenshot(path=str(OUT/'hotkey-conflict-state.png'));expect(settings_page.get_by_role('alert')).to_be_visible();assert call('snipcast_get_config')['commands']['hotkey']=='Alt+Space'
   settings_page.get_by_role('heading',name='Команды',exact=True,level=2).click()
   field.click();settings_page.wait_for_timeout(500);native_keys([0x11,0x12,0x10,0x79])
   wait(lambda:call('snipcast_get_config')['commands']['hotkey'].endswith('+F10'))
   settings_page.get_by_role('heading',name='Команды',exact=True,level=2).click()
   root();expect(search()).to_be_focused()
   settings_page.get_by_role('button',name='Emoji',exact=True).click()
  check('record Alt+Space, open globally, reject conflict and restore',hotkey_settings)
  def disable_command():
   focus_settings();settings_page.get_by_role('switch',name='Включить Emoji').click();wait(lambda:not call('snipcast_get_config')['commands']['items']['emoji']['enabled']);root();search().fill('faces');expect(page.locator('[role=option]')).to_have_count(0)
   focus_settings();settings_page.get_by_role('switch',name='Включить Emoji').click();wait(lambda:call('snipcast_get_config')['commands']['items']['emoji']['enabled'])
  check('disabled command disappears from search',disable_command)
  def refresh_apps():
   import shutil
   shutil.copyfile(apps/'Snipcast QA Launcher.lnk',apps/'Snipcast E2E Added.lnk')
   focus_settings();settings_page.get_by_role('button',name='Приложения',exact=True).click();settings_page.get_by_role('button',name='Обновить список приложений',exact=True).click()
   expect(settings_page.locator('strong').filter(has_text='Snipcast E2E Added')).to_be_visible(timeout=45000)
   root();search().fill('Snipcast E2E Added');expect(page.locator('[role=option]')).to_have_count(1)
  check('refresh application catalog updates settings and palette',refresh_apps)
  # Collect all sections at minimum size and both supported themes using real config.
  def themes():
   for theme in ['light','dark']:
    current=call('snipcast_get_config');current['theme']=theme;call('snipcast_save_config',incoming=current)
    for size in [(728,400),(624,320)]:
     call('plugin:window|set_size',label='commands',value={'Logical':{'width':size[0],'height':size[1]}})
     for name in ['Буфер обмена','Emoji','Переводчик','Калькулятор']:
      section(name)
      if name=='Калькулятор':search().fill('((2+3)*6)/2')
      if name=='Буфер обмена':search().fill('renamed');expect(page.locator('.commands__content')).to_contain_text('Текст с пробелами')
      assert page.locator('.palette').evaluate('(e)=>getComputedStyle(e).borderRadius')=='12px'
      assert page.locator('footer').bounding_box()['y']>=0
      shot(f'{theme}-{size[0]}-'+{'Буфер обмена':'clipboard','Emoji':'emoji','Переводчик':'translator','Калькулятор':'calculator'}[name])
  check('all sections, light/dark themes, minimum and normal size',themes)
  # Actual native outer frame, including its corners and shadow.
  try:
   from PIL import ImageGrab
   u.GetWindowRect.argtypes=[W.HWND,ctypes.POINTER(W.RECT)]
   rect=W.RECT();foreground=u.GetForegroundWindow()
   if u.GetWindowRect(foreground,ctypes.byref(rect)):ImageGrab.grab(bbox=(rect.left-12,rect.top-12,rect.right+12,rect.bottom+12)).save(OUT/'native-frame.png')
  except Exception as e:print('Frame capture:',e)
  def native_save():
   from pywinauto import Desktop
   section('Буфер обмена');search().fill('renamed');expect(page.locator('.commands__content')).to_contain_text('Текст с пробелами');action('Сохранить в файл…')
   desktop=Desktop(backend='win32')
   dlg=desktop.window(title='Сохранение');dlg.wait('visible',timeout=15)
   output=OUT/'saved-from-dialog.txt';dlg.child_window(control_id=1001,class_name='Edit').set_edit_text(str(output));dlg.type_keys('{ENTER}');wait(output.exists);assert output.read_bytes()==sample.encode('utf8');wait(lambda:not dlg.exists())
   action('Сохранить в файл…');dlg.wait('visible',timeout=15);dlg.type_keys('{ESC}');wait(lambda:not dlg.exists());page.wait_for_timeout(200);expect(search()).to_be_focused()
  check('native save dialog writes exact text and cancels with focus restored',native_save)
  def image_ocr():
   from PIL import ImageDraw,ImageFont
   current=call('snipcast_get_config');current['screenshotOcrEngine']='system';current['screenshotOcrLanguage']='en';call('snipcast_save_config',incoming=current)
   img=Image.new('RGB',(700,120),'white');ImageDraw.Draw(img).text((20,20),'SNIPCAST TEST 742',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',48),fill='black')
   stream=io.BytesIO();img.save(stream,'PNG');write_formats({u.RegisterClipboardFormatW('PNG'):stream.getvalue()})
   wait(lambda:any(c['width']==700 for c in call('snipcast_history_list',query='',kind='image',offset=0)['items']))
   section('Буфер обмена');page.get_by_label('Тип записей').select_option('image');expect(page.locator('.commands__content img')).to_be_visible();action('Распознать и скопировать текст')
   wait(lambda:'742' in clipboard_text(),25);expect(page.locator('.commands__content')).to_contain_text('742');shot('clipboard-ocr')
  check('recognize text from image through Actions and copy result',image_ocr)
  def file_clipboard():
   file=OUT/'linked-file.txt';file.write_text('E2E file',encoding='utf8');drop=struct.pack('<IiiII',20,0,0,0,1)+(str(file)+'\0\0').encode('utf-16le');write_formats({15:drop})
   wait(lambda:any(c['kind']=='files' for c in call('snipcast_history_list',query='',kind='',offset=0)['items']))
   section('Буфер обмена');page.get_by_label('Тип записей').select_option('files');expect(page.locator('.commands__content')).to_contain_text('linked-file.txt');action('Копировать');assert read_formats().get(15)==drop
   file.unlink();action('Копировать');expect(page.get_by_role('alert')).to_contain_text('перемещён или удалён')
  check('file list copy and actionable error for missing source file',file_clipboard)
  def delete_confirm():
   from pywinauto import Desktop
   section('Буфер обмена');expect(page.locator('[role=option]').first).to_be_visible();count=call('snipcast_history_list',query='',kind='',offset=0)['total'];expect(page.locator('[role=option]')).to_have_count(count)
   def answer(yes):
    dlg=Desktop(backend='win32').window(title='Очистить историю');dlg.wait('visible',timeout=15)
    choices=['Да','Yes','OK','ОК'] if yes else ['Нет','No','Cancel','Отмена']
    buttons=[b for b in dlg.descendants(class_name='Button') if b.window_text().replace('&','') in choices]
    assert len(buttons)==1,[(b.window_text(),b.control_id()) for b in dlg.descendants(class_name='Button')]
    buttons[0].click();wait(lambda:not dlg.exists())
   action('Удалить всю историю…');answer(False);expect(page.locator('[role=option]')).to_have_count(count)
   action('Удалить всю историю…');answer(True);expect(page.locator('[role=option]')).to_have_count(0)
  check('clear history confirmation cancels safely and deletes on confirm',delete_confirm)
  try:call('snipcast_commands_run',id='quit')
  except Exception:pass
  proc.wait(timeout=10);browser.close()
 print(json.dumps({'passed':sum(r['passed'] for r in results),'failed':sum(not r['passed'] for r in results),'pageErrors':errors}),flush=True)
 raise SystemExit(1 if any(not r['passed'] for r in results) or errors else 0)
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close()
