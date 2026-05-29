# Spend Profile Agent

Takes a public company's annual report (10-K or international equivalent) and returns a procurement-focused **spend profile JSON with per-field citations** an AE can scan in 30 seconds before a discovery call.

- Input: **report URL** or **uploaded PDF**.
- Output: structured JSON — total addressable spend, top 3 spend categories, YoY COGS change, procurement-relevant risks (each paired with a discovery question), named suppliers if disclosed, and a 3-sentence sales angle. Every numeric or attributed claim carries a `{page, quote, source}` citation that's substring-matched against the parsed source.
- Export: one-click **CSV** (spreadsheet-friendly), **JSON** (raw profile), or **HubSpot-shaped payload** copied to clipboard for paste into HubSpot's import or Operations Hub.
- Target: **≤ $1 per company** at scale, **~2 min** end-to-end.

---

## How it works

```
Next.js dashboard (Railway, same shape as Lead-IQ)
  ├─ /api/parse      → server-side fetch (SEC-aware UA) → LlamaParse → markdown cached
  └─ /api/extract    → deterministic regex over markdown (lib/financials.ts)
                         pulls every recognized Ind AS / US GAAP line item by anchor
                       → Groq (openai/gpt-oss-120b) selects top-3 from candidates
                       → Zod + substring citation verifier
                       → ResultPanel + export buttons (CSV / JSON / HubSpot)

Plus a Bulk tab: paste N URLs → 3 parallel workers → results table → batch export.
```

**Hybrid (regex + LLM) is the load-bearing design choice.** The LLM is bad at faithfully reading numbers from financial tables; the regex is bad at narrative judgment. We let the regex own the numbers (deterministic, citation-perfect) and the LLM own selection ranking + risks + sales angle. See `lib/financials.ts` for the anchor dictionary and `lib/verify.ts` for the citation safety net.

**Why this stack (defended in WRITEUP.md):**

- **LlamaParse** for OCR. Handles 10-Ks, Indian ARs, BSE filings, anything in PDF or HTML. Cost-effective tier ≈ $0.94/250pg.
- **Groq · `openai/gpt-oss-120b`** for the LLM. ~$0.02/extract at $1/5M tokens. 128k context.
- **Zod + substring citation verifier** for the "no hallucinated numbers" guarantee. Every `citation.quote` is substring-matched against the parsed markdown before the JSON ships. Unverifiable quotes are nulled and the UI flags them in red.

---

## Setup

```bash
git clone <this repo>
cd spend-profile-agent
cp .env.example .env.local        # fill GROQ_API_KEY, LLAMA_CLOUD_API_KEY
npm install
npm run dev                       # http://localhost:3000
```

Prerequisites: **Node 20+** (Next.js 16 / React 19). No Python, no Docker, no MCP servers to launch.

Keys live server-side only — in `.env.local` (gitignored, `chmod 600`). There is no UI surface for entering keys and the API routes do not read them from request headers. This is a single-tenant deploy by design; a multi-tenant version would front the LLM/OCR calls with per-tenant key vault entries, not a request-time pass-through.

### One-command run

```bash
npm install && npm run dev
```

### CLI smoke test (skip the UI)

Keys are read from `.env.local` server-side — no headers needed.

```bash
# 1. parse a report
curl -X POST http://localhost:3000/api/parse \
  -H "content-type: application/json" \
  -d '{"url":"https://s27.q4cdn.com/640460383/files/doc_financials/2023/ar/Caterpillar-Inc-2023-Annual-Report.pdf"}'
# returns: { sourceKey: "abc123…", sourceLabel: "...", chars: 312000 }

# 2. extract the profile
curl -X POST http://localhost:3000/api/extract \
  -H "content-type: application/json" \
  -d '{"sourceKey":"abc123…"}'
# returns: { profile: <SpendProfile>, verifier: { unverified: 0, failures: [] } }

```

---

## Sample output

A committed sample for Caterpillar (CAT, FY2025) is at [`samples/caterpillar-fy2025.json`](samples/caterpillar-fy2025.json), produced by running the agent against [the actual SEC-filed 10-K](https://www.sec.gov/Archives/edgar/data/18230/000001823026000008/cat-20251231.htm). All numbers are deterministically extracted from the income statement; all quotes substring-match the parsed markdown.

---

## Project layout

```
.
├── .claude/skills/spend-profile/
│   ├── SKILL.md             # system prompt for the extractor — the only thing
│   │                        # gpt-oss-120b sees besides the parsed report.
│   └── schema.json          # JSON Schema mirrored in lib/schema.ts (Zod)
├── app/
│   ├── api/
│   │   ├── parse/route.ts   # LlamaParse upload + cache
│   │   ├── extract/route.ts # Groq → JSON → Zod → citation verify
│   └── page.tsx
├── components/SpendProfileForm.tsx   # form + JSON panel + export bar
├── lib/
│   ├── llamaparse.ts        # thin REST client (no LlamaIndex SDK)
│   ├── groq.ts              # groq-sdk wrapper, defaults to openai/gpt-oss-120b
│   ├── cache.ts             # in-memory parsed-report cache, 1h TTL
│   ├── routing.ts           # context-fit truncation
│   ├── schema.ts            # Zod (the runtime authority)
│   └── verify.ts            # substring-match citation verifier
└── samples/caterpillar-fy2025.json
```

---

## What it costs

| Per document | OCR (LlamaParse cost-effective) | Groq gpt-oss-120b | Total |
| ------------ | ------------------------------- | ----------------- | ----- |
| 250-pg annual report | ~$0.94 (250 × $0.00375) | ~$0.02 (extract) | **~$0.96** |
| US 10-K via direct PDF | same as above | same | **~$0.96** |

The OCR pass dominates. v2 routes (EDGAR XBRL for US tickers, smaller LlamaParse tier when extraction confidence is high) drop blended cost to ~$0.30/co — see WRITEUP.md for the math.

---

## Notes & limitations (v1, intentional)

- **No ticker → URL resolution.** v1 accepts a URL or PDF directly. SEC ticker lookup → 10-K URL is in v2; today, paste the URL.
- **gpt-oss-120b context cap.** A handful of 400+ page Indian ARs may overflow 128k. We head/tail truncate at ~80k tokens and tag the JSON with a note. The verifier still runs against the *full* markdown to catch any hallucination from the truncated middle.
- **PDFs land in `tmp/uploads/`** and aren't GC'd. Fine for the take-home; would move to S3/R2 with TTL for prod.
- **No retry on schema failure.** A 422 from `/api/extract` returns the raw model output so you can debug. We'd rather surface the failure than burn a second LLM call masking a stale system prompt.

See [WRITEUP.md](WRITEUP.md) for the 1-pager: trade-offs cut, where it breaks, the 10k/mo cost math, and v2.
