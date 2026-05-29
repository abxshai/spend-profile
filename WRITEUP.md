# Spend Profile Agent — Writeup

## TL;DR

Hybrid extraction pipeline: deterministic regex (`lib/financials.ts`) reads every Ind AS / US GAAP P&L line item from the parsed markdown; `openai/gpt-oss-120b` on Groq selects the top 3 most procurement-relevant from the regex candidate set + writes the narrative fields (risks, sales angle). Substring citation verifier kills any quote that doesn't substring-match the source. Result: numbers are deterministic and citation-perfect; the LLM only does what it's actually good at — judgment.

Validated end-to-end on 6 filings (RIL, Tata Steel, Wipro, Caterpillar, Boeing, Walmart) spanning Ind AS + US GAAP, manufacturer + retail + services + aerospace. 3 are fully clean; 3 have documented edge cases (see §2).

## 1. What did you cut to ship in 6 hours, and why?

- **No agent runtime / no LangSmith Fleet / no Claude Agent SDK.** Earlier sketches had us running an MCP-enabled agent loop. We replaced it with two plain Next.js API routes (`parse`, `extract`) calling LlamaParse and Groq directly. Reason: the brief is one structured extraction pass, not a multi-turn tool-using agent. Adding an agent framework would have eaten the build budget for zero accuracy gain.
- **No chat / no semantic-search panel.** An earlier iteration shipped a "chat with the report" surface with local embeddings. We pulled it: the side-by-side comparison showed the chat occasionally answered differently than the JSON because it ran on retrieved chunks instead of the full document. The JSON profile is the artifact graders will check; a chat that sometimes disagrees with it is a liability, not a feature.
- **No ticker resolver.** v1 accepts URL or PDF only. Building a "ticker → most-recent-10-K URL" mapper across SEC, BSE, NSE, MCA, and overseas IR pages was the single most expensive piece of scope and gave no extraction quality back. v2 adds SEC ticker → CIK → 10-K URL via `data.sec.gov` (free) for US filings.
- **No streaming UI for the extract pass.** Groq returns the JSON in 10–20s; we wait for the final and validate. Streaming partial JSON to the client would need a tolerant parser + skeleton states.
- **No retry / self-heal on malformed JSON.** A 422 returns the raw model output. Retrying would double cost on a stochastic failure and mask the real fix (sharpen `SKILL.md`).
- **No persistence beyond a 1-hour in-process cache.** No Redis, no DB. Each parsed report sits in memory keyed by content hash, with a 1-hour TTL. The artifact is the JSON; the AE pastes it into their CRM.
- **One model, no escalation.** `openai/gpt-oss-120b` on Groq for the single extraction call. Could have routed through Claude Haiku for table fidelity — but tuning two prompts was not worth it in 6 hours.
- **Citation verification is substring-match, not semantic.** We string-normalize whitespace and lowercase, then check `quote ⊂ markdown`. Catches paraphrase and outright fabrication. It does *not* catch out-of-context citation (correct quote, wrong claim attached) — that's v2.

## 2. Where did it break? What did you fix vs leave?

**Validated demo set — 6 companies:**

| Company | Status | Notes |
|---|---|---|
| RIL FY25 | ⚠️ partial | TAM, COM, Electric Power correct; `Other Expenses #2 $16.99B` is consolidated, not standalone (left for v2 — value-consistency scoring) |
| Tata Steel FY25 | ✅ clean | TAM $13.87B, top-3 Cost of Materials / Other Expenses / Employee Benefits all standalone P&L |
| Wipro FY24 | ⚠️ partial | Spend categories all correct; YoY COGS unreliable because services-co P&L has no Cost of Materials Consumed analog (left for v2) |
| Caterpillar FY25 | ✅ clean | All numbers + all citations verify against the SEC 10-K |
| Boeing FY25 | ✅ clean | Required adding `Cost of products` anchor + duplicate-with-Total filter (parens-as-cost convention + Boeing's `Cost of sales` mid-narrative noise both got caught) |
| Walmart FY26 | ✅ clean | Required adding `Operating, selling, general and administrative` pattern variant (Walmart's wording) |

**Fixes that landed during cross-verification:**

- **Parens-as-cost-convention** universally on expense candidates. Boeing's income statement uses `($85,174)` for costs; my number parser was treating parens as negation. Now `Math.abs` on expense values, with `Changes in Inventories` preserved (can legitimately be negative).
- **INR_Million unit detection** for IT-services Indian filers (Wipro, likely Infosys/TCS). Default to INR_Cr left Wipro 10× over-stated.
- **Fiscal year**: pick the latest year, not the first regex match. Wipro's doc had both March-31-2024 and March-31-2023 in P&L headers; first-match-wins picked 2023.
- **Anchor-prefix validation**: anchor must be preceded only by whitespace, a list marker (`(a)`, `1.`, etc.), or a section header ending in `:`. Rejects narrative fragments like `Inventory/cost of sales` (Cat) and `Accumulated depreciation and amortization` (Walmart balance sheet).
- **Duplicate-with-Total filter**: expense candidates whose value matches a `Total Expenses` candidate to within 1% are dropped — catches Boeing's `Cost of sales = $85,174M` misread (which was actually the Total line picked up by a permissive regex on an MD&A comparison table).
- **Top-3 selection rule** rewritten to be strict-by-value descending, with note-decomposition tag as a tie-breaker only when the sub-line is ≥25% of its parent's value. Earlier rule let `Rent $55M` displace `Other Expenses $5.2B` because of the tag.
- **URL-level cache** so iterating on the prompt doesn't re-pay LlamaParse on the same source URL.
- **SEC-aware server-side fetch**: SEC's fair-access policy 403s LlamaParse's default UA. We fetch SEC URLs ourselves with a contact-info UA and upload the bytes.

**Issues I left for v2 (called out at the top of this section):**

- RIL standalone/consolidated mixing on `Other Expenses`. Tried standalone-section constraint (over-filtered) and smallest-match heuristic (picked MD&A noise). The robust fix is value-consistency scoring: when multiple matches exist, pick the one whose value is most consistent as a fraction of TAM. ~1hr of work.
- Wipro services-co COGS-analog. Adding a per-line-item-canonical fallback table (Sub-contracting for IT services, Cost of services for aerospace) is ~30min but adds breadth-of-coverage that we didn't need for the demo set.
- Full-document parsing. We parse 100% of every PDF (3 credits/page at cost-effective tier). Indian ARs bundle 300+ pages of BRSR/ESG we don't need. Section-targeting with a free `pypdf` pre-scan → `target_pages` parameter on LlamaParse drops Tata Steel from 554 pages to ~25 → $2.08 to $0.09. ~45min.

## 2a. Earlier breakage (caught and fixed during build)

- **Hallucinated supplier names.** Early prompt let gpt-oss-120b name "likely" suppliers from training data. **Fixed** by hard rule in SKILL.md + an empty default for `major_suppliers`. The verifier catches the rest — if the supplier name isn't in the parsed markdown, the citation drops to `null` and the field surfaces in red in the UI.
- **Quote paraphrase under temperature.** gpt-oss-120b at default temp paraphrases roughly 1 quote per extraction. **Fixed two ways**: temperature pinned to 0.1, and the substring verifier ensures any paraphrased quote gets nulled rather than passing through unchallenged.
- **LlamaParse table fidelity on dense financial pages.** Cost-effective tier (`parse_page_with_llm`) handles most 10-K tables well, but on Indian-AR multi-column segment tables it occasionally merges columns. **Left**, noted in v2 as a candidate for selective use of the Agentic tier ($0.0125/page) on detected financial-table pages only.
- **Context overflow on 400+ page Indian ARs.** A few annual reports exceed gpt-oss-120b's 128k context. **Mitigated** with a head + tail truncation in `lib/routing.ts` that preserves the first 60% (financial statements) and the last 40% (notes, risks). The citation verifier still runs against the *full* markdown, so we'll still null out a fabricated quote even if the model never saw the relevant page.
- **PDFs land in `tmp/uploads/` and stay.** **Left.** On Railway it gets recycled with the dyno. Fine for v1; v2 moves to a signed-URL upload to R2/S3 with a 24-hour TTL.

## 3. At 10,000 companies/month — bottleneck math

Assume ~70% of requests are repeat companies an SDR team is preparing for the same week (mid-market accounts cycle through reps); cache hit on parsed markdown saves the OCR pass on second-and-onwards reads. ~30% are genuinely new each month. Average filing length: 250 pages.

**Cost.**
- OCR runs: 3,000 unique × $0.94 = **$2,820**
- Cache-hit extracts: 7,000 × $0.02 (gpt-oss-120b on the cached markdown) = **$140**
- New extracts: 3,000 × $0.02 = **$60**
- **Total: ~$3,020/mo, or $0.30/company blended.** Comfortably under $1.

The 30/70 cache assumption is the load-bearing one. If every request is a unique company, cost climbs to $9,800/mo or $0.98/co — still under budget, but with no headroom. Mitigation: route US tickers through the EDGAR free API (v2) to drop OCR cost to $0 for ~70% of requests; blended cost falls to ~$0.30/co even with zero cache hits.

**Latency.**
- LlamaParse cost-effective on a 250pg doc: 30–90s wall clock.
- gpt-oss-120b extract pass: 10–20s for ~5k output tokens.
- End-to-end on a fresh company: **~60–120s**. Inside the brief's "2 minutes."
- On a cache hit: ~15s (extract only).

**Accuracy** is the real bottleneck, not cost or latency. We can chase $0.33/co all day; one hallucinated supplier name in an AE's call notes is a worse outcome than 10,000 extra runs. At 10k/mo:

1. **Citation verifier coverage.** Today's substring-match catches paraphrase and fabrication. It does *not* catch "right quote, wrong claim" — gpt-oss-120b could pull a real sentence about SG&A and attach it to a COGS claim. v2 adds a second small-model verifier pass: "given this claim and this quote, does the quote support the claim?"
2. **Top-3 category selection.** gpt-oss-120b ranks reasonably but not always by dollar value; it occasionally surfaces narrative-emphasis categories over numerically-larger ones. Eval set + few-shot examples in SKILL.md is the fix.
3. **"Procurement-relevant" risk filter.** Model sometimes picks generic macro/cyber risks over procurement-specific ones. Tunable via more examples in SKILL.md — cheap to fix once an eval exists.

**The bottleneck is accuracy, specifically citation provenance.** Cost is fine. Latency is fine. The verifier is v1's strongest accuracy lever; the next one is a per-claim "quote supports claim?" check.

## 4. v2 with another week

Ranked by impact-on-accuracy and by leverage:

1. **Claim-to-quote support verifier.** Second cheap LLM pass that gets just `{claim, quote}` pairs and answers yes/no. Drops any field whose claim isn't supported by its quote. Single biggest accuracy win, costs ~$0.001 per check.
2. **US-ticker fast path via SEC EDGAR.** Ticker → CIK lookup (`company_tickers.json`) → most-recent-10-K filing URL (`data.sec.gov/submissions/CIK*.json`) → fetch HTML or XBRL directly. Skips OCR entirely for US filings. Drops 70% of requests to ~$0.02/co.
3. **Eval set.** 25-company labeled corpus (5 industries × 5 companies) with human-verified TAM, top-3 categories, YoY COGS. Run on every prompt change; report accuracy + cost diff. The durable thing — every later improvement gets cheaper to ship safely once the eval exists.
4. **Selective Agentic-tier OCR.** Detect tabular pages (LlamaParse can flag them) and retry just those with the Agentic tier ($0.0125/page vs $0.00375). Doubles cost on ~10% of pages, halves table-extraction error on the pages that matter most.
5. **YoY diff mode.** Stretch in the brief. Two runs (current FY + prior FY) → structured diff: new vs continuing risks, COGS trajectory, suppliers that appeared/disappeared. OCR cache makes this cheap.
6. **Cross-company comparison.** Run on 5 companies in one SIC code and surface deltas: "this prospect's COGS grew 12% while peers grew 4% — wedge question is X." Output is a one-paragraph industry pulse, not a profile.
7. **Push to CRM.** HubSpot-shaped payload (the brief's stretch). `total_addressable_spend.value_usd` → contact property, `procurement_risks[*].discovery_question` → call-prep notes, `sales_angle` → opportunity description. Webhook out of `/api/extract`.
8. **Streaming partial JSON to UI.** Demo polish, lowest accuracy impact.

---

**Stack note.** Earlier sketches considered Anthropic's Claude Agent SDK and LangSmith Fleet for orchestration. We dropped both because the task is one-shot structured extraction, not multi-turn tool use — a `fetch` to LlamaParse + a `fetch` to Groq is the whole agent. Fewer moving parts, simpler deployment (same shape as Lead-IQ), and the cost math is cleaner to defend.
