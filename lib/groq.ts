import Groq from "groq-sdk";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const DEFAULT_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

export function groqClient(apiKey: string): Groq {
  return new Groq({ apiKey });
}

export async function complete(
  apiKey: string,
  messages: ChatMessage[],
  opts: { temperature?: number; responseFormat?: "json_object" | "text"; maxTokens?: number } = {}
): Promise<string> {
  const client = groqClient(apiKey);
  const res = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 4096,
    response_format: opts.responseFormat === "json_object" ? { type: "json_object" } : undefined,
  });
  return res.choices[0]?.message?.content ?? "";
}
