"""Independent native text editor fixture: its message loop never waits for Playwright."""
import json,sys,tkinter as tk,ctypes
from pathlib import Path
root=Path(sys.argv[1]);window=tk.Tk();window.title('Snipcast E2E paste target');window.geometry('480x200+20+20')
editor=tk.Text(window);editor.pack(fill='both',expand=True);last=0
def tick():
 global last
 try:
  command=json.loads((root/'target-command.json').read_text(encoding='utf8'))
  if command['id']!=last:
   if command['action']=='clear':editor.delete('1.0','end')
   if command['action']=='focus':window.deiconify();window.lift();editor.focus_force()
   if command['action']=='close':window.destroy();return
   last=command['id']
 except (OSError,ValueError):pass
 state={'id':last,'hwnd':window.winfo_id(),'text':editor.get('1.0','end-1c')}
 try:
  tmp=root/'target-state.tmp';tmp.write_text(json.dumps(state),encoding='utf8');tmp.replace(root/'target-state.json')
 except OSError:pass
 window.after(30,tick)
tick();window.mainloop()
