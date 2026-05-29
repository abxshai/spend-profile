// v1 accepts a URL or a PDF upload. Ticker → URL resolution is deferred to v2
// (the writeup explains why: cleaner one-path architecture, no SEC EDGAR
// resolver to maintain). The "URL" can be anything LlamaParse can fetch —
// SEC 10-K, BSE annual-report PDF, Investor-Relations page.

export type AgentInput =
  | { kind: "url"; url: string; label?: string }
  | { kind: "upload"; filename: string };

// gpt-oss-120b on Groq has a 128k-token context. A 250-page annual report
// typically lands around 60k-120k tokens of markdown. We cap input at ~80k
// tokens (≈ 320k chars) and concat head + tail when over — financial
// statements live at both ends of a 10-K, narrative middle is least dense.
const CHAR_CAP = 320_000;

export function fitToContext(markdown: string): string {
  if (markdown.length <= CHAR_CAP) return markdown;
  const headSize = Math.floor(CHAR_CAP * 0.6);
  const tailSize = CHAR_CAP - headSize - 200;
  return (
    markdown.slice(0, headSize) +
    `\n\n---\n[document truncated: ${markdown.length - CHAR_CAP} chars elided from the middle for context fit]\n---\n\n` +
    markdown.slice(-tailSize)
  );
}
