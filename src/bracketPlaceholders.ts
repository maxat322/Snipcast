/** Уникальные подписи из `[текст]` в порядке первого появления (пустые `[]` пропускаются). */
export function extractOrderedBracketLabels(text: string): string[] {
  const re = /\[([^\]]+)\]/g;
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1]!.trim();
    if (!inner) continue;
    if (seen.has(inner)) continue;
    seen.add(inner);
    order.push(inner);
  }
  return order;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Подставляет значения для каждой метки из `labels`. */
export function applyBracketReplacements(text: string, labels: string[], values: Record<string, string>): string {
  let out = text;
  for (const label of labels) {
    const re = new RegExp(`\\[${escapeRegExp(label)}\\]`, "g");
    out = out.replace(re, values[label] ?? "");
  }
  return out;
}
