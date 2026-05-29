// Three export shapes for a SpendProfile. All pure functions, all run client-side.
// No auth, no setup, no per-user friction — the user owns the destination.

import type { SpendProfile } from "./schema";

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(p: SpendProfile): string {
  const cats = p.top_3_spend_categories;
  const risks = p.procurement_risks;
  const cat = (i: number) => cats[i] ?? { category: "", value_usd: null };
  const risk = (i: number) => risks[i] ?? { risk: "", discovery_question: "" };

  const headers = [
    "company_name", "ticker", "country", "fiscal_year",
    "tam_usd", "tam_basis",
    "top_category_1", "top_category_1_usd",
    "top_category_2", "top_category_2_usd",
    "top_category_3", "top_category_3_usd",
    "yoy_cogs_delta_pct", "current_cogs_usd", "prior_cogs_usd",
    "risk_1", "risk_1_discovery_question",
    "risk_2", "risk_2_discovery_question",
    "risk_3", "risk_3_discovery_question",
    "major_suppliers",
    "sales_angle",
    "notes",
  ];

  const row = [
    p.company.name, p.company.ticker, p.company.country, p.fiscal_year,
    p.total_addressable_spend.value_usd, p.total_addressable_spend.basis,
    cat(0).category, cat(0).value_usd,
    cat(1).category, cat(1).value_usd,
    cat(2).category, cat(2).value_usd,
    p.yoy_cogs_change.delta == null ? null : (p.yoy_cogs_change.delta * 100).toFixed(2),
    p.yoy_cogs_change.current_year_value_usd,
    p.yoy_cogs_change.prior_year_value_usd,
    risk(0).risk, risk(0).discovery_question,
    risk(1).risk, risk(1).discovery_question,
    risk(2).risk, risk(2).discovery_question,
    p.major_suppliers.map((s) => s.name).join("; "),
    p.sales_angle,
    p.notes ?? "",
  ];

  return headers.map(csvCell).join(",") + "\n" + row.map(csvCell).join(",") + "\n";
}

export function toJSON(p: SpendProfile): string {
  return JSON.stringify(p, null, 2);
}

// Shaped for HubSpot's Companies + Engagements (NOTE) v3 APIs. The user can paste
// company.properties into POST /crm/v3/objects/companies, and note into the
// associated NOTE engagement. Custom properties prefixed `spend_profile_` so
// they don't collide with HubSpot's built-ins; user creates them once in
// Settings → Properties → Companies.
export function toHubSpotPayload(p: SpendProfile): string {
  const topCats = p.top_3_spend_categories
    .map((c) => `${c.category}${c.value_usd ? ` ($${(c.value_usd / 1e9).toFixed(2)}B)` : ""}`)
    .join(" | ");

  const risks = p.procurement_risks
    .map((r, i) => `${i + 1}. ${r.risk}\n   Ask: ${r.discovery_question}`)
    .join("\n");

  const payload = {
    company: {
      properties: {
        name: p.company.name,
        ticker_symbol: p.company.ticker ?? "",
        country: p.company.country,
        spend_profile_fy: p.fiscal_year,
        spend_profile_tam_usd: p.total_addressable_spend.value_usd,
        spend_profile_tam_basis: p.total_addressable_spend.basis,
        spend_profile_top_categories: topCats,
        spend_profile_yoy_cogs_delta: p.yoy_cogs_change.delta,
        spend_profile_major_suppliers: p.major_suppliers.map((s) => s.name).join(", "),
        spend_profile_sales_angle: p.sales_angle,
        spend_profile_generated_at: new Date().toISOString(),
      },
    },
    note: {
      engagement: { type: "NOTE" },
      metadata: {
        body: [
          `Spend profile — ${p.company.name} (FY${p.fiscal_year})`,
          "",
          p.sales_angle,
          "",
          "Procurement-relevant risks:",
          risks,
        ].join("\n"),
      },
    },
  };
  return JSON.stringify(payload, null, 2);
}

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function slugForFile(p: SpendProfile): string {
  const base = p.company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base || "spend-profile"}-fy${p.fiscal_year}`;
}

// Batch exports — share the per-profile shape so a CSV opened in Sheets has
// one company per row, and the JSON / HubSpot exports are arrays the consumer
// can iterate.
export function toBatchCSV(profiles: SpendProfile[]): string {
  if (profiles.length === 0) return "";
  const first = toCSV(profiles[0]).split("\n");
  const header = first[0];
  const rows = profiles.map((p) => toCSV(p).split("\n")[1]);
  return [header, ...rows].join("\n") + "\n";
}

export function toBatchJSON(profiles: SpendProfile[]): string {
  return JSON.stringify(profiles, null, 2);
}

export function toBatchHubSpotPayload(profiles: SpendProfile[]): string {
  return JSON.stringify(
    profiles.map((p) => JSON.parse(toHubSpotPayload(p))),
    null,
    2
  );
}
