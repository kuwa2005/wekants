const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
const KEY_MAX = 10;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function asciiWords(title: string): string[] {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export function keyBase(title: string): string {
  const words = asciiWords(title).filter((word) => /^[A-Z]/.test(word));
  let base: string | undefined;
  if (words.length >= 2) {
    base = words.map((word) => word[0]).join("").slice(0, 6);
  } else if (words.length === 1) {
    base = words[0]?.slice(0, 4);
  }
  if (!base || !/^[A-Z]/.test(base) || base.length < 2) {
    base = base && /^[A-Z]/.test(base) ? `${base}B` : "BOARD";
  }
  return base.replace(/[^A-Z0-9]/g, "").slice(0, KEY_MAX);
}

function keyWithNumber(base: string, taken: Set<string>, from: number): { key: string; n: number } {
  if (from <= 2 && !taken.has(base) && isValidKey(base)) {
    return { key: base, n: 1 };
  }
  for (let n = Math.max(2, from); ; n += 1) {
    const suffix = String(n);
    const candidate = base.slice(0, KEY_MAX - suffix.length) + suffix;
    if (!taken.has(candidate) && isValidKey(candidate)) {
      return { key: candidate, n };
    }
  }
}

export function suggestKey(title: string, taken: Set<string> = new Set()): string {
  return keyWithNumber(keyBase(title), taken, 2).key;
}

export function planBoardKeys(
  boards: Array<{ id: string; title: string }>,
  taken: Set<string> = new Set(),
): Array<{ id: string; key: string }> {
  const next = new Map<string, number>();
  const plan: Array<{ id: string; key: string }> = [];
  for (const board of boards) {
    const base = keyBase(board.title);
    const { key, n } = keyWithNumber(base, taken, next.get(base) || 2);
    next.set(base, n + 1);
    taken.add(key);
    plan.push({ id: board.id, key });
  }
  return plan;
}

export function formatCardKey(key: string, number: number | null | undefined): string {
  if (number == null || number <= 0) {
    return "";
  }
  return isValidKey(key) ? `${key}-${number}` : `#${number}`;
}

export function parseCardKey(text: string): { key: string; number: number } | null {
  const match = /^\s*([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})\s*$/.exec(String(text || ""));
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { key: match[1].toUpperCase(), number: Number(match[2]) };
}

export function normalizeKey(input: string): string {
  return String(input || "").trim().toUpperCase();
}
