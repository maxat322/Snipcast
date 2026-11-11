"""Send actual Windows keyboard input from an independent native input process."""
import ctypes,sys,time,threading
from ctypes import wintypes as W
u=ctypes.windll.user32
class KInput(ctypes.Structure):_fields_=[('vk',W.WORD),('scan',W.WORD),('flags',W.DWORD),('time',W.DWORD),('extra',ctypes.c_size_t)]
class MInput(ctypes.Structure):_fields_=[('x',W.LONG),('y',W.LONG),('data',W.DWORD),('flags',W.DWORD),('time',W.DWORD),('extra',ctypes.c_size_t)]
class IPayload(ctypes.Union):_fields_=[('keyboard',KInput),('mouse',MInput)]
class NativeInput(ctypes.Structure):_fields_=[('kind',W.DWORD),('payload',IPayload)]
def send(seq):
 # A pass-through observer acknowledges our injected events through the Windows
 # hook chain. It never creates DOM events or changes the target application.
 marker=0x534e514b;ready=threading.Event();seen=[];owner={}
 callback_type=ctypes.WINFUNCTYPE(ctypes.c_ssize_t,ctypes.c_int,W.WPARAM,W.LPARAM)
 class LowKey(ctypes.Structure):_fields_=[('vk',W.DWORD),('scan',W.DWORD),('flags',W.DWORD),('time',W.DWORD),('extra',ctypes.c_size_t)]
 u.SetWindowsHookExW.argtypes=[ctypes.c_int,callback_type,W.HINSTANCE,W.DWORD];u.SetWindowsHookExW.restype=W.HANDLE
 u.CallNextHookEx.argtypes=[W.HANDLE,ctypes.c_int,W.WPARAM,W.LPARAM];u.CallNextHookEx.restype=ctypes.c_ssize_t
 u.UnhookWindowsHookEx.argtypes=[W.HANDLE]
 @callback_type
 def observer(code,msg,data):
  result=u.CallNextHookEx(None,code,msg,data)
  if code==0 and ctypes.cast(data,ctypes.POINTER(LowKey)).contents.extra==marker:seen.append(msg)
  return result
 def pump():
  owner['thread']=ctypes.windll.kernel32.GetCurrentThreadId();hook=u.SetWindowsHookExW(13,observer,None,0);owner['hook']=hook;ready.set()
  try:
   message=W.MSG()
   while u.GetMessageW(ctypes.byref(message),None,0,0)>0:pass
  finally:
   if hook:u.UnhookWindowsHookEx(hook)
 thread=threading.Thread(target=pump,daemon=True);thread.start();assert ready.wait(3) and owner['hook']

 sequence=[(v,0) for v in seq]+[(v,2) for v in reversed(seq)]
 batch=(NativeInput*len(sequence))(*(NativeInput(kind=1,payload=IPayload(keyboard=KInput(vk=v,scan=u.MapVirtualKeyW(v,0),flags=f,extra=marker))) for v,f in sequence))
 deadline=time.monotonic()+3
 try:
  assert u.SendInput(len(batch),batch,ctypes.sizeof(NativeInput))==len(batch)
  while len(seen)<len(batch) and time.monotonic()<deadline:time.sleep(.01)
  assert len(seen)==len(batch),f'Windows input delivery: {len(seen)}/{len(batch)}'
  time.sleep(.15)
 finally:u.PostThreadMessageW(owner['thread'],0x12,0,0);thread.join(3)

def hold(vk,total_ms,delay_ms,rate_ms):
 """Hold one key like a physical keyboard: press, OS-style auto-repeat keydowns, release."""
 extended=1 if 0x21<=vk<=0x2e else 0
 def one(flags):
  flags|=extended
  event=(NativeInput*1)(NativeInput(kind=1,payload=IPayload(keyboard=KInput(vk=vk,scan=u.MapVirtualKeyW(vk,0),flags=flags,extra=0x534e514b))))
  assert u.SendInput(1,event,ctypes.sizeof(NativeInput))==1
 start=time.perf_counter();one(0)
 if delay_ms<total_ms:
  time.sleep(delay_ms/1000)
  while (time.perf_counter()-start)*1000+rate_ms<total_ms:one(0);time.sleep(rate_ms/1000)
 time.sleep(max(0,total_ms/1000-(time.perf_counter()-start)));one(2);time.sleep(.05)

if __name__=="__main__":
 if sys.argv[1:2]==['--hold']:hold(*[int(v,0) for v in sys.argv[2:6]])
 else:send([int(v,0) for v in sys.argv[1:]])
