/** Плейсхолдеры вложений: `["имя файла"]` — путь относительно папки files в Snipcast. */
const FILE_LINK_RE = /\["([^"]+)"\]/g;

export function extractFileLinkRefs(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(FILE_LINK_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    const ref = m[1]!.trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

export function stripFileLinkPlaceholders(text: string): string {
  return text
    .replace(new RegExp(FILE_LINK_RE.source, "g"), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
