"""Run browser tests using an already installed Chromium when revisions differ."""
import os, runpy, sys
from pathlib import Path
from playwright.sync_api import BrowserType

original=BrowserType.launch
installed=sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win*/chrome.exe'))
def launch(self, **kwargs):
    if self.name=='chromium' and not Path(self.executable_path).exists() and installed:
        kwargs.setdefault('executable_path',str(installed[-1]))
    return original(self,**kwargs)
BrowserType.launch=launch
script=sys.argv.pop(1)
sys.argv[0]=script
sys.path.insert(0,str(Path(script).resolve().parent))
runpy.run_path(script,run_name='__main__')
