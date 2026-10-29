"""Build the production native video engine for video_scene_quality.py.

Usage: python -B tests/build_video_quality_dll.py <run-name>
Outputs are isolated in .qa-work/video-scenes/<run-name>/.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = (ROOT / '.qa-work/video-scenes' / sys.argv[1]).resolve()
assert OUT.is_relative_to(ROOT / '.qa-work/video-scenes')
OUT.mkdir(parents=True, exist_ok=True)
shaders = OUT / 'shaders'
shaders.mkdir(exist_ok=True)
kits = Path(os.environ['ProgramFiles(x86)']) / 'Windows Kits/10/bin'
fxc = sorted(p for p in kits.glob('*/x64/fxc.exe'))[-1]
for entry in ['ResizePassH', 'ResizePassV', 'ResizeLinearPassH', 'ResizeLinearPassV',
              'ConvertSinglePass', 'ConvertPass1', 'ConvertPass2']:
    bytecode = shaders / f'{entry}.dxbc'
    subprocess.run([str(fxc), '/nologo', '/O3', '/Qstrip_reflect', '/Qstrip_debug',
                    '/T', 'cs_5_0', '/E', entry, '/Fo', str(bytecode),
                    str(ROOT / 'src-tauri/vendor/wcap/wcap_shaders.hlsl')], check=True)
    subprocess.run([str(fxc), '/nologo', '/compress', '/Vn', entry + 'ShaderBytes',
                    '/Fo', str(shaders / f'{entry}.dcs'), '/Fh',
                    str(shaders / f'{entry}.h'), str(bytecode)], check=True)
vswhere = Path(os.environ['ProgramFiles(x86)']) / 'Microsoft Visual Studio/Installer/vswhere.exe'
instances = json.loads(subprocess.check_output([str(vswhere), '-all', '-products', '*', '-format', 'json', '-utf8'], encoding='utf8'))
setup = Path(instances[0]['installationPath']) / 'VC/Auxiliary/Build/vcvars64.bat'
result = subprocess.run(f'cmd /d /s /c ""{setup}" >nul && set"',
                        capture_output=True, text=True, check=True)
env = dict(os.environ)
for line in result.stdout.splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        env[key] = value
compiler = Path(env['VCToolsInstallDir']) / 'bin/Hostx64/x64/cl.exe'
libs = ['ntdll', 'dxgi', 'd3dcompiler', 'd3d11', 'dwmapi', 'mfplat', 'mfuuid',
        'mfreadwrite', 'evr', 'strmiids', 'ksuser', 'mmdevapi', 'ole32', 'oleaut32',
        'wmcodecdspuuid', 'avrt', 'OneCore', 'CoreMessaging', 'windowscodecs',
        'shlwapi', 'uxtheme', 'msimg32', 'user32', 'gdi32', 'shell32', 'uuid']
subprocess.run([str(compiler), '/nologo', '/LD', '/O2', '/MT', '/std:c11',
                '/experimental:c11atomics', '/DNDEBUG',
                '/I' + str(ROOT / 'src-tauri/vendor/wcap'), '/I' + str(OUT),
                str(ROOT / 'src-tauri/native/video.c'), '/Fo' + str(OUT / 'video.obj'),
                '/Fe' + str(OUT / 'video.dll'), '/link',
                '/EXPORT:snipcast_video_record', '/EXPORT:snipcast_video_probe',
                '/EXPORT:snipcast_video_export', *[lib + '.lib' for lib in libs]],
               env=env, cwd=OUT, check=True)
