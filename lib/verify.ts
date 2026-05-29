// Citation verifier. The brief is unforgiving on hallucinated numbers, and
// gpt-oss-120b is fast/cheap but more prone to paraphrase than Claude Opus.
// Defense: every citation.quote must literally substring-match the parsed
// markdown (after whitespace normalization). If it doesn't, we drop the
// citation to null and tag a note — the agent's claim survives, but downstream
// readers can see we couldn't anchor it.

import type { SpendProfile } from "./schema";

// Aggressive normalization — collapse the structural noise LlamaParse leaves
// behind in financial tables (pipes, bold markers, code backticks, heading
// hashes, blockquote markers, em-dash variants, non-breaking spaces) so a
// quote that originated from a tabular line still matches its source.
function normalize(s: string): string {
  return s
    .replace(/[|*`_~#>]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function quoteAppears(quote: string, haystack: string): boolean {
  const q = normalize(quote);
  if (q.length < 8) return false;
  return normalize(haystack).includes(q);
}

export function verifyCitations(
  profile: SpendProfile,
  sourceMarkdown: string
): { profile: SpendProfile; failures: string[] } {
  const failures: string[] = [];
  const haystack = sourceMarkdown;

  const check = (path: string, citation: SpendProfile["total_addressable_spend"]["citation"]) => {
    if (!citation) return citation;
    if (quoteAppears(citation.quote, haystack)) return citation;
    failures.push(`${path}: quote not found in source`);
    return null;
  };

  const copy: SpendProfile = JSON.parse(JSON.stringify(profile));
  copy.total_addressable_spend.citation = check("total_addressable_spend", copy.total_addressable_spend.citation);
  copy.yoy_cogs_change.citation = check("yoy_cogs_change", copy.yoy_cogs_change.citation);
  copy.top_3_spend_categories = copy.top_3_spend_categories.map((c, i) => ({
    ...c,
    citation: check(`top_3_spend_categories[${i}]`, c.citation),
  }));
  copy.procurement_risks = copy.procurement_risks.map((r, i) => ({
    ...r,
    citation: check(`procurement_risks[${i}]`, r.citation),
  }));
  copy.major_suppliers = copy.major_suppliers.map((s, i) => ({
    ...s,
    citation: check(`major_suppliers[${i}]`, s.citation),
  }));

  if (failures.length > 0) {
    const note = `Citation verifier dropped ${failures.length} unverifiable quote(s): ${failures.join("; ")}`;
    copy.notes = copy.notes ? `${copy.notes}\n${note}` : note;
  }
  return { profile: copy, failures };
}
