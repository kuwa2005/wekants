import type { BoardSnapshot } from "./types.ts";

export type CardDraft = {
  title: string;
  description: string;
};

export type ListDraft = {
  title: string;
  cards: CardDraft[];
};

export type BoardDraft = {
  title: string;
  lists: ListDraft[];
};

function headingText(line: string, level: number): string | null {
  const prefix = `${"#".repeat(level)} `;
  if (!line.startsWith(prefix)) {
    return null;
  }
  return line.slice(prefix.length).trim();
}

/** Serialize a board to a portable Markdown document. */
export function boardToMarkdown(snapshot: BoardSnapshot): string {
  const lists = snapshot.lists.slice().sort((a, b) => a.rank - b.rank);
  const lines: string[] = [`# ${snapshot.board.title}`, ""];
  for (const list of lists) {
    lines.push(`## ${list.title}`, "");
    const cards = snapshot.cards
      .filter((card) => card.listId === list.id)
      .slice()
      .sort((a, b) => a.rank - b.rank);
    for (const card of cards) {
      lines.push(`### ${card.title}`, "");
      if (card.description.trim()) {
        lines.push(card.description.trim(), "");
      }
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

/** Parse a Markdown board file (`#` board, `##` lists, `###` cards). */
export function markdownToBoardDraft(markdown: string, fallbackTitle = "Imported"): BoardDraft {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let title = fallbackTitle;
  const lists: ListDraft[] = [];
  let currentList: ListDraft | null = null;
  let currentCard: CardDraft | null = null;
  const body: string[] = [];

  const flushCard = () => {
    if (!currentCard || !currentList) {
      return;
    }
    currentCard.description = body.join("\n").trim();
    body.length = 0;
    currentList.cards.push(currentCard);
    currentCard = null;
  };

  for (const raw of lines) {
    const board = headingText(raw, 1);
    if (board) {
      flushCard();
      title = board || title;
      continue;
    }
    const list = headingText(raw, 2);
    if (list) {
      flushCard();
      currentList = { title: list, cards: [] };
      lists.push(currentList);
      continue;
    }
    const card = headingText(raw, 3);
    if (card) {
      flushCard();
      if (!currentList) {
        currentList = { title: "Imported", cards: [] };
        lists.push(currentList);
      }
      currentCard = { title: card, description: "" };
      continue;
    }
    if (currentCard) {
      body.push(raw);
    }
  }
  flushCard();
  if (lists.length === 0) {
    lists.push({ title: "Notes", cards: [] });
  }
  return { title, lists };
}

/** Parse a single Markdown file dropped onto a list: first heading is the title, the rest is the body. */
export function markdownToCardDraft(markdown: string, fallbackTitle: string): CardDraft {
  const text = markdown.replace(/\r\n/g, "\n").trim();
  const match = text.match(/^(#{1,6})\s+(.+)\n?([\s\S]*)$/);
  if (!match) {
    return { title: fallbackTitle, description: text };
  }
  return {
    title: match[2].trim() || fallbackTitle,
    description: match[3].trim(),
  };
}
