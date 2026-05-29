"use client";

import { useState } from "react";
import type { SpendProfile } from "@/lib/schema";
import {
  toBatchCSV,
  toBatchJSON,
  toBatchHubSpotPayload,
  downloadFile,
} from "@/lib/export";

type Status = "queued" | "parsing" | "extracting" | "done" | "error";
type Row = {
  url: string;
  status: Status;
  profile?: SpendProfile;
  error?: string;
  unverified?: number;
};

const STATUS_LABEL: Record<Status, string> = {
  queued: "queued",
  parsing: "parsing…",
  extracting: "extracting…",
  done: "✓ done",
  error: "✗ error",
};

const STATUS_COLOR: Record<Status, string> = {
  queued: "text-neutral-500",
  parsing: "text-amber-300",
  extracting: "text-amber-300",
  done: "text-emerald-300",
  error: "text-red-300",
};

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

export default function BulkProfileForm() {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);

  // Long parses (large Indian ARs through LlamaParse) can run 3–5 minutes,
  // and browsers / intermediaries occasionally drop the underlying TCP
  // connection mid-stream — the request shows up as "Failed to fetch" client
  // side even though the server is still working. Retry transient fetch
  // errors twice with a short backoff before giving up.
  async function fetchJsonWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetch(url, init);
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw new Error(`${label} failed after 3 attempts: ${(lastErr as Error)?.message ?? "unknown"}`);
  }

  async function runOne(idx: number, url: string) {
    setRows((r) => r.map((x, i) => (i === idx ? { ...x, status: "parsing" } : x)));
    try {
      const pr = await fetchJsonWithRetry(
        "/api/parse",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        },
        "parse"
      );
      const parseData = await pr.json();
      if (!pr.ok) throw new Error(parseData.error ?? "parse failed");

      setRows((r) => r.map((x, i) => (i === idx ? { ...x, status: "extracting" } : x)));
      const er = await fetchJsonWithRetry(
        "/api/extract",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceKey: parseData.sourceKey }),
        },
        "extract"
      );
      const data = await er.json();
      if (!er.ok) {
        if (data?.error === "INSUFFICIENT_SOURCE") {
          throw new Error(`Insufficient source: ${data.detail}`);
        }
        throw new Error(data.error ?? "extract failed");
      }
      setRows((r) =>
        r.map((x, i) =>
          i === idx
            ? {
                ...x,
                status: "done",
                profile: data.profile,
                unverified: data.verifier?.unverified ?? 0,
              }
            : x
        )
      );
    } catch (e) {
      setRows((r) =>
        r.map((x, i) => (i === idx ? { ...x, status: "error", error: (e as Error).message } : x))
      );
    }
  }

  async function runAll() {
    const urls = text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && /^https?:\/\//i.test(s));
    if (urls.length === 0) return;

    setRunning(true);
    setRows(urls.map((u) => ({ url: u, status: "queued" })));

    // Bounded-concurrency promise pool: N workers pull from a shared index
    // until the queue drains. 3 parallel workers cuts wall-clock ~3× for a
    // 3-URL batch (LlamaParse tolerates ~10 concurrent jobs per key, and
    // Groq calls are naturally spaced by the parse waits, so rate-limit
    // pressure is minimal).
    const CONCURRENCY = 3;
    let nextIdx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= urls.length) return;
        await runOne(i, urls[i]);
      }
    });
    await Promise.all(workers);
    setRunning(false);
  }

  const done = rows.filter((r) => r.status === "done" && r.profile);
  const profiles = done.map((r) => r.profile as SpendProfile);
  const slug = `spend-profiles-${new Date().toISOString().slice(0, 10)}`;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="block text-xs uppercase tracking-wide text-neutral-500">
          Paste annual-report URLs, one per line
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={"https://www.ril.com/reports/RIL-Integrated-Annual-Report-2024-25.pdf\nhttps://www.sec.gov/Archives/edgar/data/18230/000001823026000008/cat-20251231.htm\nhttps://www.tatasteel.com/media/23971/ir-fy2024-25.pdf"}
          disabled={running}
          className="w-full rounded-md bg-neutral-900 px-3 py-2 font-mono text-xs ring-1 ring-neutral-800 focus:outline-none focus:ring-amber-500/50 disabled:opacity-50"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={runAll}
            disabled={running || text.trim().length === 0}
            className="rounded-md bg-amber-500/90 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {running
              ? `Running ${rows.filter((r) => r.status === "done" || r.status === "error").length}/${rows.length}…`
              : "Run all"}
          </button>
          <span className="text-xs text-neutral-500">
            3 parallel workers · resubmits hit the URL cache and skip LlamaParse
          </span>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900/40 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">TAM</th>
                <th className="px-3 py-2 text-left">Top category</th>
                <th className="px-3 py-2 text-right">YoY COGS</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const p = r.profile;
                const top = p?.top_3_spend_categories?.[0];
                const delta = p?.yoy_cogs_change?.delta;
                return (
                  <tr key={i} className="border-t border-neutral-800/80">
                    <td className="px-3 py-2">
                      {p ? (
                        <span className="font-medium">{p.company.name}</span>
                      ) : (
                        <span className="break-all text-xs text-neutral-500">{r.url}</span>
                      )}
                      {p && (
                        <div className="text-xs text-neutral-500">
                          {p.company.country} · FY{p.fiscal_year}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {fmtUsd(p?.total_addressable_spend?.value_usd ?? null)}
                    </td>
                    <td className="px-3 py-2">
                      {top ? (
                        <span>
                          <span>{top.category}</span>{" "}
                          <span className="text-xs text-neutral-500">
                            ({fmtUsd(top.value_usd)})
                          </span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {delta != null ? `${(delta * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className={`px-3 py-2 ${STATUS_COLOR[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                      {r.error && (
                        <div className="mt-1 text-xs text-red-400/80">{r.error}</div>
                      )}
                      {p && r.unverified != null && r.unverified > 0 && (
                        <div className="mt-1 text-xs text-red-400/80">
                          {r.unverified} unverified citation{r.unverified === 1 ? "" : "s"}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {done.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => downloadFile(`${slug}.csv`, toBatchCSV(profiles), "text/csv;charset=utf-8")}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:border-amber-500/40 hover:text-amber-200"
          >
            ↓ Download CSV ({done.length} rows)
          </button>
          <button
            type="button"
            onClick={() => downloadFile(`${slug}.json`, toBatchJSON(profiles), "application/json")}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:border-amber-500/40 hover:text-amber-200"
          >
            ↓ Download JSON
          </button>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(toBatchHubSpotPayload(profiles));
            }}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:border-amber-500/40 hover:text-amber-200"
          >
            ⧉ Copy HubSpot payload (array)
          </button>
          <span className="ml-1 text-xs text-neutral-500">
            CSV opens in Sheets with one company per row.
          </span>
        </div>
      )}
    </div>
  );
}
