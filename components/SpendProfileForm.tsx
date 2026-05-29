"use client";

import { useState } from "react";
import type { SpendProfile } from "@/lib/schema";
import { toCSV, toJSON, toHubSpotPayload, downloadFile, slugForFile } from "@/lib/export";
import BulkProfileForm from "./BulkProfileForm";

type Mode = "url" | "upload" | "bulk";
type Citation = { page: number | null; quote: string; source: "edgar" | "ocr" } | null;

function ExportBar({ profile }: { profile: SpendProfile }) {
  const [copied, setCopied] = useState<"hubspot" | null>(null);
  const slug = slugForFile(profile);

  const onCsv = () => downloadFile(`${slug}.csv`, toCSV(profile), "text/csv;charset=utf-8");
  const onJson = () => downloadFile(`${slug}.json`, toJSON(profile), "application/json");
  const onHubSpot = async () => {
    await navigator.clipboard.writeText(toHubSpotPayload(profile));
    setCopied("hubspot");
    setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onCsv}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:border-amber-500/40 hover:text-amber-200"
      >
        ↓ Download CSV
      </button>
      <button
        type="button"
        onClick={onJson}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:border-amber-500/40 hover:text-amber-200"
      >
        ↓ Download JSON
      </button>
      <button
        type="button"
        onClick={onHubSpot}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:border-amber-500/40 hover:text-amber-200"
      >
        {copied === "hubspot" ? "✓ Copied" : "⧉ Copy HubSpot payload"}
      </button>
      <span className="ml-1 text-xs text-neutral-500">
        zero-auth · open CSV in Sheets/Excel · HubSpot payload paste-ready
      </span>
    </div>
  );
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

function CitedValue({ label, value, citation }: { label: string; value: string; citation: Citation }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
      {citation ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 text-xs text-neutral-400 underline-offset-2 hover:text-amber-300 hover:underline"
          >
            {open ? "hide" : "show"} citation · p.{citation.page ?? "?"}
          </button>
          {open && (
            <blockquote className="mt-2 border-l-2 border-amber-500/40 pl-3 text-xs italic text-neutral-300">
              {citation.quote}
            </blockquote>
          )}
        </>
      ) : (
        <div className="mt-2 text-xs text-red-400/80">unverified — quote not found in source</div>
      )}
    </div>
  );
}

function ResultPanel({ profile, unverified }: { profile: SpendProfile; unverified: number }) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-semibold">
          {profile.company.name}{" "}
          <span className="text-neutral-500">
            ({profile.company.ticker ?? profile.company.country} · FY{profile.fiscal_year})
          </span>
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">{profile.sales_angle}</p>
        {unverified > 0 && (
          <p className="mt-2 text-xs text-red-400/80">
            {unverified} citation{unverified === 1 ? "" : "s"} could not be verified against the source markdown
            (dropped to null). See `notes` in raw JSON.
          </p>
        )}
        <ExportBar profile={profile} />
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <CitedValue
          label="Total addressable spend"
          value={`${fmtUsd(profile.total_addressable_spend.value_usd)} · ${profile.total_addressable_spend.basis}`}
          citation={profile.total_addressable_spend.citation}
        />
        <CitedValue
          label="YoY COGS change"
          value={
            profile.yoy_cogs_change.delta == null
              ? "—"
              : `${(profile.yoy_cogs_change.delta * 100).toFixed(1)}%`
          }
          citation={profile.yoy_cogs_change.citation}
        />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-neutral-300">Top spend categories</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {profile.top_3_spend_categories.map((c, i) => (
            <CitedValue key={i} label={c.category} value={fmtUsd(c.value_usd)} citation={c.citation} />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-neutral-300">Procurement risks</h3>
        <ul className="space-y-3">
          {profile.procurement_risks.map((r, i) => (
            <li key={i} className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="text-sm">{r.risk}</div>
              <div className="mt-1 text-xs text-amber-300">Ask: {r.discovery_question}</div>
              {r.citation ? (
                <div className="mt-2 text-xs italic text-neutral-400">
                  &ldquo;{r.citation.quote}&rdquo;
                </div>
              ) : (
                <div className="mt-2 text-xs text-red-400/80">unverified</div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {profile.major_suppliers.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-neutral-300">Named suppliers</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {profile.major_suppliers.map((s, i) => (
              <CitedValue key={i} label={s.name} value={s.relationship ?? "mentioned"} citation={s.citation} />
            ))}
          </div>
        </section>
      )}

      <details className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
        <summary className="cursor-pointer text-xs text-neutral-500">Raw JSON</summary>
        <pre className="mt-2 max-h-96 overflow-auto text-xs">{JSON.stringify(profile, null, 2)}</pre>
      </details>
    </div>
  );
}

export default function SpendProfileForm() {
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<"idle" | "parsing" | "extracting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [profile, setProfile] = useState<SpendProfile | null>(null);
  const [unverified, setUnverified] = useState(0);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setProfile(null);
    setSourceLabel("");

    setStage("parsing");
    let parseData: { sourceKey: string; sourceLabel: string };
    try {
      let res: Response;
      if (mode === "upload") {
        if (!file) throw new Error("Choose a PDF first");
        const fd = new FormData();
        fd.append("file", file);
        res = await fetch("/api/parse", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/parse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });
      }
      parseData = await res.json();
      if (!res.ok) throw new Error((parseData as unknown as { error: string }).error ?? "parse failed");
    } catch (e) {
      setError((e as Error).message);
      setStage("idle");
      return;
    }
    setSourceLabel(parseData.sourceLabel);

    setStage("extracting");
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceKey: parseData.sourceKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.error === "INSUFFICIENT_SOURCE") {
          throw new Error(`Insufficient source: ${data.detail}`);
        }
        throw new Error(data.error ?? "extract failed");
      }
      setProfile(data.profile);
      setUnverified(data.verifier?.unverified ?? 0);
      setStage("done");
    } catch (e) {
      setError((e as Error).message);
      setStage("idle");
    }
  }

  const modeLabels: Record<Mode, string> = {
    url: "URL",
    upload: "Upload PDF",
    bulk: "Bulk (URLs)",
  };

  return (
    <>
      <div className="mb-4 flex gap-2">
        {(["url", "upload", "bulk"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              mode === m
                ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-500/40"
                : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {modeLabels[m]}
          </button>
        ))}
      </div>

      {mode === "bulk" ? (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-6">
          <BulkProfileForm />
        </div>
      ) : (
        <form
          onSubmit={onSubmit}
          className="space-y-6 rounded-lg border border-neutral-800 bg-neutral-900/30 p-6"
        >
          {mode === "url" ? (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/annual-report.pdf or https://www.sec.gov/…/10-K"
              className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm ring-1 ring-neutral-800 focus:outline-none focus:ring-amber-500/50"
            />
          ) : (
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-200 ring-1 ring-neutral-700 hover:bg-neutral-700 hover:ring-amber-500/40">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path d="M9.25 13.25a.75.75 0 0 0 1.5 0V4.636l2.955 3.129a.75.75 0 0 0 1.09-1.03l-4.25-4.5a.75.75 0 0 0-1.09 0l-4.25 4.5a.75.75 0 1 0 1.09 1.03L9.25 4.636v8.614Z" />
                  <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                </svg>
                <span>{file ? "Replace PDF" : "Choose PDF"}</span>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="sr-only"
                />
              </label>
              {file ? (
                <span className="truncate text-xs text-neutral-300" title={file.name}>
                  {file.name}{" "}
                  <span className="text-neutral-500">
                    ({(file.size / 1024 / 1024).toFixed(1)} MB)
                  </span>
                </span>
              ) : (
                <span className="text-xs text-neutral-500">No file selected — PDFs only</span>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={stage === "parsing" || stage === "extracting"}
            className="rounded-md bg-amber-500/90 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {stage === "parsing"
              ? "Parsing report…"
              : stage === "extracting"
                ? "Extracting profile…"
                : "Generate spend profile"}
          </button>
        </form>
      )}

      {mode !== "bulk" && error && (
        <div className="mt-6 rounded-md border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {mode !== "bulk" && profile && (
        <div className="mt-8 space-y-6">
          <div className="text-xs text-neutral-500">
            Parsed source: <span className="font-mono">{sourceLabel}</span>
          </div>
          <ResultPanel profile={profile} unverified={unverified} />
        </div>
      )}
    </>
  );
}
