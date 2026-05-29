import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { get } from "@/lib/cache";
import { complete } from "@/lib/groq";
import { fitToContext } from "@/lib/routing";
import { SpendProfileSchema, InsufficientSourceSchema } from "@/lib/schema";
import { verifyCitations } from "@/lib/verify";
import { extractFinancials, formatCandidatesForPrompt } from "@/lib/financials";

export const runtime = "nodejs";
export const maxDuration = 120;

const SKILL_PATH = path.join(process.cwd(), ".claude/skills/spend-profile/SKILL.md");
const SCHEMA_PATH = path.join(process.cwd(), ".claude/skills/spend-profile/schema.json");

function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}

export async function POST(req: NextRequest) {
  const groqKey = process.env.GROQ_API_KEY ?? "";
  if (!groqKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY not set on the server" },
      { status: 500 }
    );
  }

  const { sourceKey } = (await req.json()) as { sourceKey?: string };
  if (!sourceKey) return NextResponse.json({ error: "Missing sourceKey" }, { status: 400 });

  const entry = get(sourceKey);
  if (!entry) return NextResponse.json({ error: "Source expired — re-parse" }, { status: 404 });

  const [skillMd, schemaJson] = await Promise.all([
    readFile(SKILL_PATH, "utf-8"),
    readFile(SCHEMA_PATH, "utf-8"),
  ]);

  const systemPrompt = `${skillMd}\n\n# JSON Schema (authoritative)\n\nYour entire response must be a single JSON object matching this schema. No prose. No fences. No commentary.\n\n\`\`\`json\n${schemaJson}\n\`\`\``;

  const financials = extractFinancials(entry.markdown);
  const candidatesBlock = formatCandidatesForPrompt(financials);

  const fittedMarkdown = fitToContext(entry.markdown);
  const userPrompt = `${candidatesBlock}\n\n---\n\n# SOURCE DOCUMENT (parsed markdown — use for narrative fields and to verify quotes)\n\n${fittedMarkdown}\n\n---\n\nProduce the spend profile JSON now. Numeric fields MUST come from the DETERMINISTIC EXTRACTION block above; narrative fields (procurement_risks, sales_angle, major_suppliers) come from the source document.`;

  let raw: string;
  try {
    raw = await complete(
      groqKey,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.1, responseFormat: "json_object", maxTokens: 4096 }
    );
  } catch (e) {
    return NextResponse.json({ error: `Groq call failed: ${(e as Error).message}` }, { status: 502 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (e) {
    return NextResponse.json(
      { error: `JSON parse failed: ${(e as Error).message}`, raw },
      { status: 422 }
    );
  }

  const insufficient = InsufficientSourceSchema.safeParse(parsed);
  if (insufficient.success) {
    return NextResponse.json(insufficient.data, { status: 422 });
  }

  const result = SpendProfileSchema.safeParse(parsed);
  if (!result.success) {
    return NextResponse.json(
      { error: "Schema validation failed", detail: result.error.message, raw },
      { status: 422 }
    );
  }

  const { profile, failures } = verifyCitations(result.data, entry.markdown);

  return NextResponse.json({
    profile,
    verifier: { unverified: failures.length, failures },
    financials: {
      filing_type: financials.filing_type,
      currency_unit: financials.currency_unit,
      candidate_count: financials.candidates.length,
      candidates: financials.candidates.map((c) => ({
        line_item: c.line_item,
        value_native: c.value_native,
        value_usd: c.value_usd,
        unit: c.unit,
        source: c.source,
        category: c.category,
        quote: c.quote,
      })),
    },
  });
}
