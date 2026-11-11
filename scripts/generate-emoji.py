"""Regenerate vendored Emoji 16 / CLDR 46 data; no runtime network dependency."""
from pathlib import Path
import urllib.request,xml.etree.ElementTree as ET,json
ROOT=Path(__file__).resolve().parents[1]
def read(url):
 error=None
 for _ in range(3):
  try:return urllib.request.urlopen(url,timeout=45).read()
  except Exception as e:error=e
 raise error
ru={};en={}
for lang,into in [('ru',ru),('en',en)]:
 for file in ['annotations','annotationsDerived']:
  root=ET.fromstring(read(f'https://raw.githubusercontent.com/unicode-org/cldr/release-46/common/{file}/{lang}.xml'))
  for a in root.iter('annotation'):
   row=into.setdefault(a.attrib.get('cp',''),{'name':'','keywords':''})
   if a.attrib.get('type')=='tts':row['name']=a.text or ''
   else:row['keywords']+=' '+(a.text or '')
text=read('https://raw.githubusercontent.com/unicode-org/unicodetools/main/unicodetools/data/emoji/16.0/emoji-test.txt').decode()
assert '# Version: 16.0' in text
items=[];group=''
for line in text.splitlines():
 if line.startswith('# group:'):group=line.split(':',1)[1].strip()
 if '; fully-qualified' not in line:continue
 nums=[int(c,16) for c in line.split(';')[0].strip().split()]
 if any(0x1f3fb<=c<=0x1f3ff for c in nums):continue
 char=''.join(chr(c) for c in nums);a=ru.get(char,ru.get(char.replace('\ufe0f',''),{}));e=en.get(char,en.get(char.replace('\ufe0f',''),{}));fallback=line.split('#',1)[1].strip().split(' ',2)[-1]
 items.append({'emoji':char,'name':a.get('name') or e.get('name') or fallback,'keywords':' '.join([a.get('keywords',''),e.get('name',''),e.get('keywords','')]),'category':group,'tone':any((char+chr(t)) in ru or (char+chr(t)) in en for t in range(0x1f3fb,0x1f400))})
p=ROOT/'src/commands';(p/'emoji.json').write_text(json.dumps(items,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
(p/'THIRD_PARTY.md').write_text('Emoji: Unicode Emoji 16.0 (emoji-test.txt), CLDR release 46 Russian and English annotations. Sources: https://unicode.org/Public/emoji/16.0/emoji-test.txt and https://github.com/unicode-org/cldr/tree/release-46/common. Unicode License V3 (UNICODE-LICENSE.txt). Glyphs are rendered by the operating system. Regenerate with python -B scripts/generate-emoji.py.\n',encoding='utf-8')
(p/'UNICODE-LICENSE.txt').write_bytes(read('https://raw.githubusercontent.com/unicode-org/cldr/release-46/LICENSE'))
print('Emoji:',len(items),'Russian annotations:',len(ru))
