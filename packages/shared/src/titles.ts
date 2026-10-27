export type TitleBatch = "one" | "many";

/** One title keeps internal line breaks. Many titles skip blank lines and keep order. */
export function titlesFromInput(text: string, batch: TitleBatch): string[] {
  if (batch === "one") {
    const title = text.trim();
    return title ? [title] : [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
