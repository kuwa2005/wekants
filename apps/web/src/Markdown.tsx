import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ source }: { source: string }) {
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
