// Deterministic P&L extractor. Runs over LlamaParse markdown before the LLM
// gets a chance to "interpret" the numbers. The agent then picks from this
// candidate list rather than searching the document freely — which is what
// caused the earlier failures on RIL (segment revenue → spend category, then
// over-cautious nulls).
//
// Scope (per the take-home brief): Ind AS (Indian companies) and US GAAP
// (US 10-Ks). Generic fallback patterns catch a few common variants.

const INR_USD_RATE_DEFAULT = 83;

export type Unit = "INR_Cr" | "INR_Lakh" | "INR_Million" | "USD_M" | "USD_B" | "unknown";

export type ExpenseCandidate = {
  line_item: string;
  value_native: number;
  prior_value_native: number | null;
  unit: Unit;
  value_usd: number | null;
  prior_value_usd: number | null;
  quote: string;
  category: "expense" | "income";
  framework: "ind_as" | "us_gaap";
  source: "primary_pl" | "note_decomposition";
};

export type FinancialsExtraction = {
  filing_type: "ind_as" | "us_gaap" | "unknown";
  currency_unit: Unit;
  inr_usd_rate: number;
  fiscal_year: number | null;
  revenue_from_operations_usd: number | null;
  candidates: ExpenseCandidate[];
};

// ---------------- Line-item dictionary ----------------

type LineItemDef = {
  canonical: string;
  patterns: RegExp[];
  category: "expense" | "income";
  framework: "ind_as" | "us_gaap";
  source: "primary_pl" | "note_decomposition";
};

const LINE_ITEMS: LineItemDef[] = [
  // Ind AS — income (for context / sanity check, NOT spend candidates)
  { canonical: "Revenue from Operations", patterns: [/revenue\s+from\s+operations\b/i], category: "income", framework: "ind_as", source: "primary_pl" },
  { canonical: "Total Income", patterns: [/\btotal\s+income\b/i], category: "income", framework: "ind_as", source: "primary_pl" },

  // Ind AS — primary P&L expense lines
  { canonical: "Cost of Materials Consumed", patterns: [/cost\s+of\s+materials\s+consumed/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Purchase of Stock-in-Trade", patterns: [/purchase\s+of\s+stock[-\s]+in[-\s]+trade/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Changes in Inventories", patterns: [/changes\s+in\s+inventories/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Excise Duty", patterns: [/^excise\s+duty\b/im], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Employee Benefits Expense", patterns: [/employee\s+benefits?\s+expense/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Finance Costs", patterns: [/\bfinance\s+costs?\b/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Depreciation / Amortisation", patterns: [/depreciation\s*[/&,]\s*amortisation/i, /depreciation\s+and\s+amortisation/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Other Expenses", patterns: [/^other\s+expenses\b/im], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Total Expenses", patterns: [/\btotal\s+expenses\b/i], category: "expense", framework: "ind_as", source: "primary_pl" },

  // Ind AS — primary P&L expense lines specific to IT-services filers
  // (Wipro / Infosys / TCS list these directly on the face of the income
  // statement rather than rolling them into "Other Expenses"). Without these
  // anchors, top-3 selection misses the dominant procurement spend (sub-
  // contracting is often the #2 line after Employee Benefits).
  { canonical: "Sub-contracting and technical fees", patterns: [/sub[-\s]?contracting\s+(?:and|&)\s+technical\s+fees?/i, /sub[-\s]?contracting\s+(?:charges|expenses?|fees?)/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Facility expenses", patterns: [/^facility\s+expenses?\b/im, /facilities\s+expenses?\b/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Software license and subscription expenses", patterns: [/software\s+licen[cs]e\s+(?:and\s+subscription\s+)?expenses?/i, /software\s+licen[cs]e\s+expense\s+for\s+internal\s+use/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Travel expenses", patterns: [/^travel\b/im, /travelling\s+expenses?/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Legal and professional charges", patterns: [/legal\s+and\s+professional\s+(?:charges|fees|expenses?)/i, /professional\s+fees\s+and\s+legal/i], category: "expense", framework: "ind_as", source: "primary_pl" },
  { canonical: "Communication expenses", patterns: [/^communication\s+(?:expenses?|costs?)?\b/im], category: "expense", framework: "ind_as", source: "primary_pl" },

  // Ind AS — Note 30 sub-items (the procurement-actionable ones, decomposing "Other Expenses")
  { canonical: "Stores, Chemicals and Packing Materials", patterns: [/stores,?\s+chemicals\s+and\s+packing\s+materials/i], category: "expense", framework: "ind_as", source: "note_decomposition" },
  { canonical: "Electric Power, Fuel and Water", patterns: [/electric\s+power,?\s+fuel\s+and\s+water/i, /^power\s+(?:and|,)\s+fuel\b/im, /power,?\s+fuel\s+and\s+water/i], category: "expense", framework: "ind_as", source: "note_decomposition" },
  { canonical: "Labour Processing, Production Royalty and Machinery Hire", patterns: [/labour\s+processing[^\n]{0,80}(?:royalty|machinery|hire)/i, /production\s+royalty/i], category: "expense", framework: "ind_as", source: "note_decomposition" },
  { canonical: "Warehousing and Distribution Expenses", patterns: [/warehousing\s+and\s+distribution/i], category: "expense", framework: "ind_as", source: "note_decomposition" },
  { canonical: "Freight and Forwarding", patterns: [/freight\s+(?:and\s+)?forwarding/i], category: "expense", framework: "ind_as", source: "note_decomposition" },
  { canonical: "Repairs to Machinery", patterns: [/repairs\s+to\s+machinery/i], category: "expense", framework: "ind_as", source: "note_decomposition" },
  { canonical: "Repairs to Building", patterns: [/repairs\s+to\s+building/i], category: "expense", framework: "ind_as", source: "note_decomposition" },
  { canonical: "Rent", patterns: [/^\s*rent\b/im], category: "expense", framework: "ind_as", source: "note_decomposition" },
  { canonical: "Insurance", patterns: [/^insurance\b/im], category: "expense", framework: "ind_as", source: "note_decomposition" },

  // US GAAP — income
  { canonical: "Total revenue", patterns: [/\btotal\s+revenues?\b/i, /\bnet\s+revenues?\b/i, /\brevenues?,?\s+net\b/i], category: "income", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Net sales", patterns: [/\bnet\s+sales\b/i], category: "income", framework: "us_gaap", source: "primary_pl" },

  // US GAAP — primary income-statement expense lines
  { canonical: "Cost of revenue", patterns: [/\bcost\s+of\s+revenues?\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Cost of goods sold", patterns: [/\bcost\s+of\s+goods\s+sold\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Cost of sales", patterns: [/\bcost\s+of\s+sales\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Cost of products", patterns: [/\bcost\s+of\s+products\s+sold\b/i, /\bcost\s+of\s+products\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Cost of services", patterns: [/\bcost\s+of\s+services\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Research and development", patterns: [/\bresearch\s+and\s+development\b/i, /\bR\s*&\s*D\s+expenses?\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  // Walmart uses "Operating, selling, general and administrative expenses" as a
  // single line; the longer variant pattern catches it with the anchor at the
  // start of the line (prefix empty), which our position rule accepts.
  { canonical: "Selling, general and administrative", patterns: [/operating,?\s+selling,?\s+general\s+and\s+administrative/i, /selling,?\s+general\s+and\s+administrative/i, /\bSG\s*&\s*A\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "General and administrative", patterns: [/^general\s+and\s+administrative/im], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Sales and marketing", patterns: [/sales\s+and\s+marketing/i, /selling\s+and\s+marketing/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Marketing", patterns: [/^marketing\s+(?:expenses?|costs?)\b/im], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Depreciation and amortization", patterns: [/depreciation\s+and\s+amortization/i, /\bD\s*&\s*A\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Interest expense", patterns: [/\binterest\s+expense\b/i], category: "expense", framework: "us_gaap", source: "primary_pl" },
  { canonical: "Total operating expenses", patterns: [/total\s+operating\s+(?:costs|expenses)/i, /total\s+costs\s+and\s+expenses/i], category: "expense", framework: "us_gaap", source: "primary_pl" },

  // US GAAP — common segment/note decomposition lines that are procurement-actionable
  { canonical: "Freight and shipping", patterns: [/\bfreight\b/i, /shipping\s+and\s+handling/i], category: "expense", framework: "us_gaap", source: "note_decomposition" },
  { canonical: "Utilities and energy", patterns: [/\benergy\s+costs?\b/i, /\butilities\s+expense\b/i], category: "expense", framework: "us_gaap", source: "note_decomposition" },
  { canonical: "Materials and supplies", patterns: [/\bmaterials\s+and\s+supplies\b/i, /\bmaterials,\s+supplies\b/i], category: "expense", framework: "us_gaap", source: "note_decomposition" },
];

// ---------------- Number parsing ----------------

// Strip OCR'd ₹-prefix glyphs (C/K/H/L/I when they sit immediately before a digit).
function stripCurrencyOcr(s: string): string {
  return s.replace(/^[₹$€£CKHLI](?=\s*\d)/i, "").trim();
}

function parseNumber(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  const neg = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
  if (s.startsWith("-")) s = s.slice(1);
  s = stripCurrencyOcr(s);
  const cleaned = s.replace(/,/g, "");
  const v = parseFloat(cleaned);
  if (isNaN(v)) return null;
  return neg ? -v : v;
}

type NumExtract = { value: number; raw: string; index: number };

const NUMBER_RE = /\(?[₹$€£CKHLI]?\s*-?\d{1,3}(?:,\d{2,3})*(?:\.\d+)?\)?/gi;

function extractNumbers(text: string): NumExtract[] {
  const out: NumExtract[] = [];
  let m: RegExpExecArray | null;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    // Require either a comma-separated form OR a value with absolute magnitude >= 100.
    // This filters page numbers, note numbers, and other small-digit noise.
    const hasComma = m[0].includes(",");
    const v = parseNumber(m[0]);
    if (v === null || isNaN(v)) continue;
    if (!hasComma && Math.abs(v) < 100) continue;
    out.push({ value: v, raw: m[0], index: m.index });
  }
  return out;
}

// ---------------- Filing-type / unit detection ----------------

function detectFilingType(md: string): "ind_as" | "us_gaap" | "unknown" {
  const indHits = (md.match(/(cost\s+of\s+materials\s+consumed|in\s+crore|Ind\s+AS|Indian\s+Accounting\s+Standards)/gi) || []).length;
  const usHits = (md.match(/(form\s+10[-\s]?K|Securities\s+and\s+Exchange\s+Commission|U\.S\.\s+GAAP|in\s+millions,?\s+except)/gi) || []).length;
  if (indHits > usHits && indHits > 0) return "ind_as";
  if (usHits > indHits && usHits > 0) return "us_gaap";
  return "unknown";
}

function detectCurrencyUnit(md: string, filing: string, maxNativeValue: number): Unit {
  if (filing === "ind_as") {
    // Wipro / Infosys / TCS report in INR millions, not crore. Look for a
    // strong unit-declaration phrase near a financial-statements header. The
    // OCR'd ₹ glyph commonly appears as a leading capital letter (C/H/I/L).
    const millionsRe = /(?:[₹CHIL₹]\s*in\s+millions|rupees?\s+in\s+millions|\(in\s+millions\b[^)]*\)\s*(?:notes|year))/i;
    if (millionsRe.test(md)) return "INR_Million";
    if (/in\s+lakh\b/i.test(md) && !/in\s+crore\b/i.test(md)) return "INR_Lakh";
    return "INR_Cr";
  }
  if (filing === "us_gaap") {
    // Textual hint: explicit "in billions" declaration.
    const textSaysBillions = /(?:\$\s*in\s+billions|dollars?\s+in\s+billions|amounts?\s+in\s+billions\s+of\s+dollars|\(\s*in\s+billions\s*\))/i.test(md);
    // Magnitude sanity check: a US filer reporting in billions would have
    // income-statement values like Revenue 67.8 / COGS 44.7. If any candidate
    // exceeds 1000, the unit is millions — no public US filer has a
    // trillion-dollar line item.
    if (textSaysBillions && maxNativeValue < 1000) return "USD_B";
    return "USD_M";
  }
  return "unknown";
}

// A line-item anchor is only legitimate when the text before it is empty,
// or one of these structural prefixes that real P&L tables use as row labels.
// Anything else (random words, narrative slashes, EBITDA-style derived prose,
// "Accumulated depreciation..." balance-sheet snippets) disqualifies the line.
function isValidAnchorPrefix(beforeText: string): boolean {
  const trimmed = beforeText.replace(/\s+$/, "");
  if (trimmed === "") return true;
  // List marker: "(a)", "(i)", "1.", "2)", bullet, dash. Optionally followed
  // by a note reference like "28 F96" (Tata Steel format).
  if (/^\s*(?:[(\[][a-z0-9ivxlcdm]{1,4}[)\]]|[\d]{1,3}\.?|[•‣◦⁃·\-–—])(?:\s+\d{1,3}\s*[A-Z]?\d*)?\s*$/i.test(trimmed)) return true;
  // Section header ending in ":" — "Operating costs:", "Expenses:", "Less:".
  if (/:\s*$/.test(beforeText)) return true;
  return false;
}

function toUsd(value: number, unit: Unit, rate: number): number | null {
  if (value == null || !isFinite(value)) return null;
  switch (unit) {
    case "INR_Cr": return (value * 1e7) / rate;
    case "INR_Lakh": return (value * 1e5) / rate;
    case "INR_Million": return (value * 1e6) / rate;
    case "USD_M": return value * 1e6;
    case "USD_B": return value * 1e9;
    default: return null;
  }
}

// ---------------- Main extractor ----------------

export function extractFinancials(markdown: string, inrUsdRate = INR_USD_RATE_DEFAULT): FinancialsExtraction {
  const filing = detectFilingType(markdown);
  const lines = markdown.split(/\r?\n/);

  // Pass 1: extract native values without committing to a currency unit yet,
  // so we can sanity-check unit detection against the magnitudes we found.
  type Native = { def: LineItemDef; value: number; prior: number | null; quote: string };
  const native: Native[] = [];

  type Match = { value: number; prior: number | null; quote: string };

  for (const def of LINE_ITEMS) {
    if (def.framework !== filing && filing !== "unknown") continue;

    const matches: Match[] = [];

    for (const raw of lines) {
      if (!raw.trim()) continue;
      // Strip the same markdown noise the verifier normalizes away, so the
      // quote we store survives the substring check downstream. Preserve case
      // and digit groups (commas) for UI readability.
      const normalized = raw
        .replace(/[|*`_~#>]/g, " ")
        .replace(/[–—−]/g, "-")
        .replace(/ /g, " ")
        .replace(/\s+/g, " ")
        .trim();

      let matchStart = -1;
      let matchEnd = -1;
      for (const pat of def.patterns) {
        pat.lastIndex = 0;
        const m = pat.exec(normalized);
        if (m) {
          matchStart = m.index;
          matchEnd = m.index + m[0].length;
          break;
        }
      }
      if (matchEnd < 0) continue;

      // The anchor must look like a table-row LABEL — meaning what comes
      // before it is whitespace, a list marker like "(a)" / "(i)" / "1.",
      // a bullet/dash, or a section header ending in ":" (e.g. "Operating
      // costs:"). Rejecting other prefixes catches narrative fragments
      // like "Inventory/cost of sales" (Cat) and "Total expenditure before
      // finance cost" (Tata Steel) that previously poisoned the candidates.
      const prefix = normalized.slice(0, matchStart);
      if (!isValidAnchorPrefix(prefix)) continue;

      const after = normalized.slice(matchEnd);
      const nums = extractNumbers(after);
      if (nums.length === 0) continue;

      matches.push({
        value: nums[0].value,
        prior: nums.length >= 2 ? nums[1].value : null,
        quote: normalized.slice(0, 220),
      });
      break; // first matching line per anchor — Indian standalone P&L typically
             // appears before consolidated; choosing smaller-match across all
             // matches sounded clever but picks up MD&A comparison-metric noise.
    }

    if (matches.length === 0) continue;

    native.push({
      def,
      value: matches[0].value,
      prior: matches[0].prior,
      quote: matches[0].quote,
    });
  }

  // Pass 2: detect unit with magnitude info, then map to typed candidates.
  const maxNative = native.reduce((m, n) => Math.max(m, Math.abs(n.value)), 0);
  const unit = detectCurrencyUnit(markdown, filing, maxNative);

  // Parens around expense values mean "cost subtracted from revenue", not
  // negation. Applies universally — US GAAP income statements use parens for
  // costs (Boeing-style); Ind AS filers with 20-F sections like Wipro use the
  // same convention. Skip only line items that can legitimately be negative.
  const PRESERVE_SIGN = new Set(["Changes in Inventories"]);

  let candidates: ExpenseCandidate[] = native.map((n) => {
    const flipParens = n.def.category === "expense" && !PRESERVE_SIGN.has(n.def.canonical);
    const v = flipParens ? Math.abs(n.value) : n.value;
    const p = n.prior !== null ? (flipParens ? Math.abs(n.prior) : n.prior) : null;
    return {
      line_item: n.def.canonical,
      value_native: v,
      prior_value_native: p,
      unit,
      value_usd: toUsd(v, unit, inrUsdRate),
      prior_value_usd: p !== null ? toUsd(p, unit, inrUsdRate) : null,
      quote: n.quote,
      category: n.def.category,
      framework: n.def.framework,
      source: n.def.source,
    };
  });

  // De-duplicate: if a non-Total expense candidate has the same value as a
  // Total candidate (within 1%), it's almost certainly a misread of the same
  // row by two anchors. Drop the non-Total one. Catches Boeing's bogus
  // "Cost of sales = $85,174M" (which is really the Total costs and expenses
  // figure picked up by a permissive regex on a comparison table).
  const totalCandidates = candidates.filter((c) =>
    /^total\s/i.test(c.line_item) && c.category === "expense"
  );
  if (totalCandidates.length > 0) {
    candidates = candidates.filter((c) => {
      if (totalCandidates.includes(c)) return true;
      if (c.category !== "expense") return true;
      for (const t of totalCandidates) {
        if (Math.abs(t.value_native) < 1) continue;
        const diff = Math.abs(c.value_native - t.value_native) / Math.abs(t.value_native);
        if (diff < 0.01) return false;
      }
      return true;
    });
  }

  // Indian + US ARs typically show TWO years on the P&L for comparison
  // (current + prior). The first regex match would pick the prior year on
  // Indian filings where the line reads "...March 31, 2024 ... March 31,
  // 2023". Collect every match and take the latest year.
  let fiscalYear: number | null = null;
  const fyRe = /(?:for\s+the\s+)?year\s+ended\s+(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s*,?\s*(?:\d{1,2}\s*,?\s*)?(\d{4})/gi;
  const years: number[] = [];
  let ym: RegExpExecArray | null;
  while ((ym = fyRe.exec(markdown)) !== null) {
    const yr = parseInt(ym[1]);
    if (yr >= 2000 && yr <= 2030) years.push(yr);
  }
  if (years.length > 0) fiscalYear = Math.max(...years);

  const revenue = candidates.find(
    (c) => c.line_item === "Revenue from Operations" || c.line_item === "Total revenue" || c.line_item === "Net sales"
  );

  return {
    filing_type: filing,
    currency_unit: unit,
    inr_usd_rate: inrUsdRate,
    fiscal_year: fiscalYear,
    revenue_from_operations_usd: revenue?.value_usd ?? null,
    candidates,
  };
}

// ---------------- Render for the LLM prompt ----------------

export function formatCandidatesForPrompt(ex: FinancialsExtraction): string {
  const expenses = ex.candidates
    .filter((c) => c.category === "expense")
    .sort((a, b) => (b.value_native || 0) - (a.value_native || 0));
  const incomes = ex.candidates.filter((c) => c.category === "income");

  const out: string[] = [];
  out.push("# DETERMINISTIC EXTRACTION (use these values verbatim; do not infer or compute alternatives)");
  out.push("");
  out.push(`Filing type: ${ex.filing_type}`);
  out.push(`Native currency unit: ${ex.currency_unit}`);
  out.push(`INR→USD rate applied (when unit is INR_*): ${ex.inr_usd_rate}`);
  if (ex.fiscal_year) out.push(`Detected fiscal year: ${ex.fiscal_year}`);
  out.push("");
  out.push("## INCOME / REVENUE (context only — NEVER use as a spend category)");
  if (incomes.length === 0) out.push("  (no revenue line detected)");
  for (const c of incomes) {
    const usd = c.value_usd != null ? `$${(c.value_usd / 1e9).toFixed(2)}B` : "?";
    out.push(`  - ${c.line_item}: ${usd}`);
  }
  out.push("");
  out.push("## EXPENSE CANDIDATES (pick top 3 from this list for top_3_spend_categories)");
  out.push("");
  out.push("Each entry below gives `value_usd` already converted to plain US dollars. COPY it verbatim into top_3_spend_categories[i].value_usd. Do NOT divide, multiply, or reformat.");
  out.push("");
  if (expenses.length === 0) out.push("  (no expense lines detected — note this in 'notes' and proceed with sales_angle only)");
  for (const c of expenses) {
    const usd = c.value_usd != null ? c.value_usd.toFixed(0) : "null";
    const display = c.value_usd != null ? ` (display: $${(c.value_usd / 1e9).toFixed(2)}B)` : "";
    const priorUsd = c.prior_value_usd != null ? `, prior_value_usd: ${c.prior_value_usd.toFixed(0)}` : "";
    const tag = c.source === "note_decomposition" ? " [from notes — procurement-actionable sub-line]" : "";
    out.push(`  - ${c.line_item}${tag}`);
    out.push(`      value_usd: ${usd}${display}${priorUsd}`);
    out.push(`      quote: "${c.quote}"`);
  }
  out.push("");
  out.push("# SELECTION RULES");
  out.push("- top_3_spend_categories[*].value_usd MUST match the corresponding candidate's value_usd above. No rewriting numbers.");
  out.push("- top_3_spend_categories[*].citation.quote MUST be the 'quote' string from the candidate verbatim.");
  out.push("- Prefer note_decomposition entries (procurement-actionable sub-lines) over their parent roll-up when both are present and the sub-line is in the top expense bucket.");
  out.push("- yoy_cogs_change uses the 'Cost of Materials Consumed' candidate (Ind AS) or 'Cost of revenue' / 'Cost of goods sold' candidate (US GAAP). Compute delta from value_native and prior_value_native.");
  out.push("- total_addressable_spend uses Total Expenses (Ind AS) or Total operating expenses (US GAAP) when present; otherwise sum of the top-3 expenses with basis='unavailable'.");

  return out.join("\n");
}
