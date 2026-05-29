---
name: spend-profile
description: Extract a procurement-focused spend profile from a public company's annual report (10-K or international equivalent). Produces the JSON schema in schema.json with a verbatim citation for every numeric or attributed claim. Use whenever the user provides an annual report and asks for a procurement / discovery-call profile.
metadata:
  type: project
---

# Spend Profile Extraction

You are preparing an Account Executive for a discovery call. The output must be **factual, cited, and useful in 30 seconds of scanning** — not a data dump.

The user message contains the full annual report parsed as markdown. Work entirely from that text. Do not bring in outside knowledge about the company, its competitors, its industry, or its supplier relationships. The brief is unforgiving: "If the report doesn't say it, your agent shouldn't say it."

## Procedure

1. **Locate the source spans first, write the JSON second.** For every numeric field and every quoted risk/supplier claim, you must hold a verbatim sentence or row from the report. If you cannot find a span, the field is `null` with `citation: null` — never guess.

2. **Total addressable spend** uses the deterministic extraction's `Total Expenses` (Ind AS) or `Total operating expenses` (US GAAP) candidate when present. Set `total_addressable_spend.value_usd` from that candidate; set `basis` to `total_opex_ex_da_sbc` (we treat it as the operating-expense base; D&A and SBC subtraction is a v2 refinement).

   If **no Total Expenses / Total operating expenses candidate is present**, sum the `value_usd` of the three categories you chose for `top_3_spend_categories` and set `basis` to `cogs_plus_sga`. **Do NOT use `basis: unavailable` in this case** — `unavailable` is reserved for filings where zero expense candidates were extracted at all.

3. **Top 3 spend categories — SELECT from the DETERMINISTIC EXTRACTION block in the user message.** A regex pre-extractor has already located every recognized P&L line item (Ind AS or US GAAP) and decomposed Note-level sub-items. Your job is to **pick** the three from that list — NOT to re-search the markdown for numbers, NOT to compute alternatives, NOT to skip the list and pull from segment reporting.

   **Procedure (follow strictly in this order):**

   **Step 1 — Build the ranked pool.** Take every EXPENSE candidate from the extraction block. Drop the ones that are roll-up totals you'd never quote as a category: `Total Expenses`, `Total operating expenses`, `Total costs and expenses`. Drop revenue/income candidates entirely. Sort the rest by `value_usd` descending. Call this `RANKED`.

   **Step 2 — Pick the top 3 from RANKED.** Default selection is simply the three largest by `value_usd`. **Do not pick a smaller candidate over a larger one** — `Rent $55M` should never displace `Other Expenses $5.2B`, regardless of any tag.

   **Step 3 — Apply the note-decomposition tie-breaker, ONLY when conditions are met.** If RANKED has a parent roll-up like `Other Expenses ₹61,384 Cr` AND there's a `[from notes — procurement-actionable sub-line]` candidate whose `value_usd` is **at least 25% of the parent's value_usd**, you may substitute the note sub-line for the parent. This is what makes the output procurement-actionable instead of generic. Example (RIL): `Other Expenses $7.40B` parent → swap for `Electric Power, Fuel and Water $2.65B` (35% of parent — passes 25% threshold). Counter-example (Tata Steel): `Other Expenses $5.20B` parent → `Rent $0.06B` (1% of parent — FAILS threshold, keep the parent).

   **Step 4 — Verify the picks come from RANKED's top 5.** If your final top-3 contains an entry that wasn't in the top 5 by value_usd, you've made a mistake. Re-check.

   **Numbers and quotes are non-negotiable:**
   - `top_3_spend_categories[i].value_usd` MUST equal the candidate's `value_usd` from the extraction block. Do not round, recompute, or substitute.
   - `top_3_spend_categories[i].citation.quote` MUST be the exact `quote` string from the chosen candidate. Verbatim.
   - If no expense candidates were extracted, return `INSUFFICIENT_SOURCE` rather than guessing.

4. **Number-format handling for Indian Annual Reports.** Indian companies report in **₹ Crore** (1 Cr = 10 million ₹) or **₹ Lakh** (1 Lakh = 100,000 ₹). The Indian thousands separator places the first comma after 3 digits and then every 2 digits ("5,32,792" = 532,792, not 5.32 million).

   For `value_usd`, convert using the FY-end INR/USD rate disclosed in the report (usually in the auditor's notes, the foreign currency translation note, or the segment-revenue USD-equivalents column). If the rate isn't disclosed, use the most-recent FY-end rate you have evidence for from the report itself (e.g., a USD/INR mention in MD&A); fall back to ~83 INR/USD only if nothing in the document supports a different rate, and note `"Used ~83 INR/USD as no FY-end rate disclosed"` in `notes`.

   **OCR artifacts on ₹**: LlamaParse often renders `₹` as a leading capital letter — `C`, `K`, `H`, `L`, or `I` — before a comma-separated number. Treat any of these patterns followed by an Indian-format number ("C 5,32,792", "K 3,84,021") as a ₹ symbol. Do not include the OCR'd letter in the citation quote unless it appeared that way in the source.

5. **YoY change in COGS / opex** uses the deterministic extraction's "Cost of Materials Consumed" candidate (Ind AS) or "Cost of revenue" / "Cost of goods sold" candidate (US GAAP). Compute `delta = (value_native − prior_value_native) / prior_value_native` as a decimal (e.g., `0.087` for +8.7%). Set `current_year_value_usd` and `prior_year_value_usd` from the same candidate. Use that candidate's `quote` for the citation.

6. **Procurement-relevant risks** — pick 2–3 from the Risk Factors section that an SDR could turn into a discovery question. Examples that qualify: raw-material price volatility, single-source supplier exposure, semiconductor / freight / energy cost pressure, geographic concentration of a supply base, regulatory exposure on imports. Examples that do **not** qualify and should be excluded: generic cybersecurity, generic macroeconomic, generic litigation, ESG framing without a procurement hook.

7. **Major suppliers** — only populate if named in the report (rare in 10-Ks, more common in Indian ARs and proxy statements). Empty array is acceptable and correct most of the time. Do not infer suppliers from press coverage or memory.

8. **Sales angle** — 3 sentences, written *to the AE*, not the prospect. Sentence 1: what's pressuring their procurement budget. Sentence 2: the wedge our product creates against that pressure. Sentence 3: the question to open the call with. No marketing language. No "leverage", "synergy", "unlock". Plain English.

## Citation contract

Every numeric or attributed field carries a `citation` object: `{ page: number | null, quote: string, source: "ocr" }`.

- `quote` must appear **verbatim** in the parsed markdown. A downstream verifier substring-matches every quote against the source text and drops to `null` anything that doesn't match. Paraphrases will fail the check and the field will appear unverified in the UI.
- `page` is best-effort. Parsed markdown sometimes carries page anchors (e.g. `<!-- page 42 -->` or `# Page 42`) — use them when present. If not, `null` is acceptable.
- `source` is always `"ocr"` in this pipeline.

## Output contract

Return **only** a single JSON object matching `schema.json`. No prose before or after, no Markdown fences, no commentary. The route parses your response with `response_format: { type: "json_object" }`; anything else is a hard failure.

## Refusal rule

If the parsed markdown is shorter than ~500 words of usable text (corrupted PDF, paywalled filing, wrong URL), return:

```json
{ "error": "INSUFFICIENT_SOURCE", "detail": "<one sentence explaining what was missing>" }
```

Do not fabricate fields to fill the schema.
