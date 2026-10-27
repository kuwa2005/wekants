const SIMILAR = 0.5;
const DUPLICATE = 0.8;
const TITLE_WEIGHT = 2;
const MAX_TEXT = 2000;

const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

export type SimilarCard = {
  id: string;
  title: string;
  listId: string;
  score: number;
  duplicate: boolean;
};

type CardLike = {
  id: string;
  title: string;
  description?: string;
  listId: string;
  archived?: boolean;
};

export function normalizeText(text: string): string {
  return String(text || "")
    .slice(0, MAX_TEXT)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  const normalized = normalizeText(text);
  if (!normalized) {
    return out;
  }
  for (const word of normalized.split(" ")) {
    if (UNSPACED.test(word)) {
      const chars = [...word];
      if (chars.length === 1) {
        out.add(chars[0] ?? "");
      }
      for (let i = 0; i + 2 <= chars.length; i += 1) {
        out.add((chars[i] ?? "") + (chars[i + 1] ?? ""));
      }
      continue;
    }
    const padded = ` ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      out.add(padded.slice(i, i + 3));
    }
  }
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) {
    return 0;
  }
  let common = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) {
    if (large.has(gram)) {
      common += 1;
    }
  }
  return (2 * common) / (a.size + b.size);
}

function similarity(
  query: { titleGrams: Set<string>; descriptionGrams: Set<string> },
  card: CardLike,
): number {
  const titleScore = dice(query.titleGrams, trigrams(card.title));
  if (!query.descriptionGrams.size) {
    return titleScore;
  }
  const otherDescription = trigrams(card.description ?? "");
  if (!otherDescription.size) {
    return titleScore;
  }
  const descriptionScore = dice(query.descriptionGrams, otherDescription);
  return (TITLE_WEIGHT * titleScore + descriptionScore) / (TITLE_WEIGHT + 1);
}

export function rankSimilarCards(
  query: { title?: string; description?: string },
  cards: CardLike[],
  options?: { limit?: number; min?: number; excludeId?: string | null },
): SimilarCard[] {
  const limit = options?.limit ?? 5;
  const min = options?.min ?? SIMILAR;
  const excludeId = options?.excludeId ?? null;
  const prepared = {
    titleGrams: trigrams(query?.title ?? ""),
    descriptionGrams: trigrams(query?.description ?? ""),
  };
  if (!prepared.titleGrams.size) {
    return [];
  }
  const ranked: SimilarCard[] = [];
  for (const card of cards) {
    if (!card || card.archived || card.id === excludeId) {
      continue;
    }
    const score = similarity(prepared, card);
    if (score >= min) {
      ranked.push({
        id: card.id,
        title: card.title,
        listId: card.listId,
        score,
        duplicate: score >= DUPLICATE,
      });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return ranked.slice(0, limit);
}
