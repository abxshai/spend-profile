// Thin REST client for LlamaParse (LlamaIndex Cloud). We hit the API directly
// rather than pulling @llamaindex/cloud — the SDK adds 30+ MB of transitive
// deps for what is fundamentally three HTTP calls.
//
// Flow: upload (file or URL) → poll job → fetch markdown result.
// Docs: https://docs.cloud.llamaindex.ai/llamaparse/getting_started

const BASE = "https://api.cloud.llamaindex.ai/api/v1/parsing";

type Tier = "fast" | "cost_effective" | "agentic";

const TIER_TO_PARSE_MODE: Record<Tier, string> = {
  fast: "parse_page_without_llm",
  cost_effective: "parse_page_with_llm",
  agentic: "parse_page_with_agent",
};

type UploadResponse = { id: string; status: string };
type JobStatus = { id: string; status: "PENDING" | "SUCCESS" | "ERROR"; error?: string };

function authHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

async function uploadFile(apiKey: string, file: File | Blob, filename: string, tier: Tier): Promise<string> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("parse_mode", TIER_TO_PARSE_MODE[tier]);
  form.append("output_format", "markdown");

  const res = await fetch(`${BASE}/upload`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
  });
  if (!res.ok) throw new Error(`LlamaParse upload failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as UploadResponse;
  return data.id;
}

async function uploadUrl(apiKey: string, url: string, tier: Tier): Promise<string> {
  const form = new FormData();
  form.append("input_url", url);
  form.append("parse_mode", TIER_TO_PARSE_MODE[tier]);
  form.append("output_format", "markdown");

  const res = await fetch(`${BASE}/upload`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
  });
  if (!res.ok) throw new Error(`LlamaParse URL upload failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as UploadResponse;
  return data.id;
}

async function waitForJob(apiKey: string, jobId: string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 2000;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/job/${jobId}`, { headers: authHeaders(apiKey) });
    if (!res.ok) throw new Error(`LlamaParse job poll failed (${res.status})`);
    const data = (await res.json()) as JobStatus;
    if (data.status === "SUCCESS") return;
    if (data.status === "ERROR") throw new Error(`LlamaParse job error: ${data.error ?? "unknown"}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 8000);
  }
  throw new Error("LlamaParse job timeout (4 min)");
}

async function getMarkdown(apiKey: string, jobId: string): Promise<string> {
  const res = await fetch(`${BASE}/job/${jobId}/result/markdown`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`LlamaParse result fetch failed (${res.status})`);
  const data = (await res.json()) as { markdown: string };
  return data.markdown;
}

export type ParseInput =
  | { kind: "url"; url: string }
  | { kind: "upload"; file: File | Blob; filename: string };

// SEC's fair-access policy requires a contact-info User-Agent. LlamaParse's
// own fetcher doesn't send one, so URLs on sec.gov 403 when handed to its
// /upload endpoint with `input_url`. Workaround: fetch SEC URLs ourselves
// with the right header, then hand the bytes to LlamaParse as a file upload.
async function fetchUrlAsBlob(url: string): Promise<{ blob: Blob; filename: string }> {
  const isSec = /(^https?:\/\/)?(www\.)?sec\.gov\b/i.test(url);
  const ua = isSec
    ? "abishai.nathanael@deccan.ai abishai"
    : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

  const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "*/*" }, redirect: "follow" });
  if (!res.ok) throw new Error(`URL fetch failed (${res.status}) — server-side: ${url}`);

  const buf = await res.arrayBuffer();
  const contentType = res.headers.get("content-type")?.split(";")[0].trim() ?? "application/octet-stream";
  const blob = new Blob([buf], { type: contentType });

  const last = new URL(url).pathname.split("/").pop() || "filing";
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(last);
  const guess = contentType.includes("pdf") ? ".pdf" : contentType.includes("html") || contentType.includes("xml") ? ".htm" : "";
  return { blob, filename: hasExt ? last : last + guess };
}

export async function parseReport(
  apiKey: string,
  input: ParseInput,
  tier: Tier = "cost_effective"
): Promise<{ markdown: string; jobId: string }> {
  let jobId: string;

  if (input.kind === "url") {
    // Always go through server-side fetch first — solves SEC UA gating and
    // gives us a single LlamaParse code path. Slight bandwidth cost vs.
    // letting LlamaParse fetch directly, but worth the reliability.
    const { blob, filename } = await fetchUrlAsBlob(input.url);
    jobId = await uploadFile(apiKey, blob, filename, tier);
  } else {
    jobId = await uploadFile(apiKey, input.file, input.filename, tier);
  }

  await waitForJob(apiKey, jobId);
  const markdown = await getMarkdown(apiKey, jobId);
  return { markdown, jobId };
}
