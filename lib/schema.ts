import { z } from "zod";

const Citation = z
  .object({
    page: z.number().int().nullable(),
    quote: z.string().min(8),
    source: z.enum(["edgar", "ocr"]),
  })
  .nullable();

export const SpendProfileSchema = z.object({
  company: z.object({
    name: z.string(),
    ticker: z.string().nullable(),
    country: z.string().length(2),
  }),
  fiscal_year: z.number().int().min(2000).max(2030),
  total_addressable_spend: z.object({
    value_usd: z.number().nullable(),
    basis: z.enum(["cogs_plus_sga", "total_opex_ex_da_sbc", "revenue_proxy", "unavailable"]),
    citation: Citation,
  }),
  top_3_spend_categories: z
    .array(
      z.object({
        category: z.string(),
        value_usd: z.number().nullable(),
        share_of_total: z.number().min(0).max(1).nullable().optional(),
        citation: Citation,
      })
    )
    .min(1)
    .max(3),
  yoy_cogs_change: z.object({
    delta: z.number().nullable(),
    current_year_value_usd: z.number().nullable(),
    prior_year_value_usd: z.number().nullable(),
    citation: Citation,
  }),
  procurement_risks: z
    .array(
      z.object({
        risk: z.string(),
        discovery_question: z.string(),
        citation: Citation,
      })
    )
    .min(2)
    .max(3),
  major_suppliers: z.array(
    z.object({
      name: z.string(),
      relationship: z.string().nullable().optional(),
      citation: Citation,
    })
  ),
  sales_angle: z.string(),
  notes: z.string().nullable().optional(),
});

export const InsufficientSourceSchema = z.object({
  error: z.literal("INSUFFICIENT_SOURCE"),
  detail: z.string(),
});

export const AgentResponseSchema = z.union([SpendProfileSchema, InsufficientSourceSchema]);

export type SpendProfile = z.infer<typeof SpendProfileSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
