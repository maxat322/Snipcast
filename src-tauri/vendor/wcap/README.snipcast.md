# wcap integration

Upstream: https://github.com/mmozeiko/wcap
Pinned revision: aa25ccb806d7a6e1c0bfdcca863aabcd8e9badfa
License: Unlicense (included in LICENSE).

The original capture, encoder, audio, resize and conversion headers are compiled
into Snipcast. The upstream executable, tray, hotkeys and settings are not used.
Shaders are compiled with the Windows SDK at build time. No runtime DLL, FFmpeg
or external encoder is distributed. `native/video.c` implements session control,
native Media Foundation trimming and WIC animated GIF export.

Integration patch: `Encoder_Stop` returns the SinkWriter finalization HRESULT so
Snipcast reports disk/finalization errors instead of marking a broken MP4 saved.
All other upstream headers are unchanged at the pinned revision.
