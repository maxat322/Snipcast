# Text tool implementation reference

The native textarea editor and its explicit submission/focus lifecycle are adapted
from the architectural approach in Excalidraw's `textWysiwyg.tsx`:

- Repository: https://github.com/excalidraw/excalidraw
- Reference revision: `ed10ac7dca7e40f3f4a31269b4bfba980d0db41e`
- Source: https://github.com/excalidraw/excalidraw/blob/ed10ac7dca7e40f3f4a31269b4bfba980d0db41e/packages/excalidraw/wysiwyg/textWysiwyg.tsx
- License: MIT; full upstream notice is retained in `licenses/excalidraw-MIT.txt`.

Snipcast does not embed the Excalidraw application or its editor package. The
scene controller, pointer gestures and browser-native line measurements are
implemented locally. In particular, native DOM Range measurements replace a
separate soft-wrap algorithm so the canvas and textarea share browser line breaks.

Run the interaction/export regression suite with:

```powershell
python tests/capture_text.py
```

It requires Python Playwright, Pillow, a Chromium installation for Playwright,
and the Vite server at http://localhost:1420. Results and screenshots are written
to `dist/text-qa/` (ignored build artifacts). This suite uses the capture demo;
native WebView2 capture and clipboard validation must be recorded separately.
