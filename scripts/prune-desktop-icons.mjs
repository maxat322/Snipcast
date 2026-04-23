/**
 * После `tauri icon` удаляет iOS/Android и лишние PNG (только desktop: Windows + macOS).
 */
import { rmSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "src-tauri", "icons");

for (const name of ["android", "ios"]) {
  const p = join(icons, name);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

const junk = [
  "64x64.png",
  "icon.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square30x30Logo.png",
  "Square310x310Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "StoreLogo.png",
];
for (const f of junk) {
  const p = join(icons, f);
  if (existsSync(p)) unlinkSync(p);
}
