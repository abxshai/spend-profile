import { NextRequest, NextResponse } from "next/server";
import { parseReport } from "@/lib/llamaparse";
import { hashContent, put, get as cacheGet, memoUrl, lookupUrl } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const llamaKey = process.env.LLAMA_CLOUD_API_KEY ?? "";
  if (!llamaKey) {
    return NextResponse.json(
      { error: "LLAMA_CLOUD_API_KEY not set on the server" },
      { status: 500 }
    );
  }

  const tier = (process.env.LLAMA_PARSE_TIER ?? "cost_effective") as
    | "fast"
    | "cost_effective"
    | "agentic";

  const contentType = req.headers.get("content-type") ?? "";
  try {
    let markdown: string;
    let sourceLabel: string;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
      }
      sourceLabel = file.name;
      const result = await parseReport(llamaKey, { kind: "upload", file, filename: file.name }, tier);
      markdown = result.markdown;
    } else {
      const body = (await req.json()) as { url?: string };
      if (!body.url) return NextResponse.json({ error: "Missing url" }, { status: 400 });
      sourceLabel = body.url;

      const cachedKey = lookupUrl(body.url);
      if (cachedKey) {
        const cached = cacheGet(cachedKey);
        if (cached) {
          return NextResponse.json({
            sourceKey: cachedKey,
            sourceLabel: cached.sourceLabel,
            chars: cached.markdown.length,
            preview: cached.markdown.slice(0, 800),
            cached: true,
          });
        }
      }

      const result = await parseReport(llamaKey, { kind: "url", url: body.url }, tier);
      markdown = result.markdown;

      const sourceKey = hashContent(markdown);
      put(sourceKey, markdown, sourceLabel);
      memoUrl(body.url, sourceKey);

      return NextResponse.json({
        sourceKey,
        sourceLabel,
        chars: markdown.length,
        preview: markdown.slice(0, 800),
        cached: false,
      });
    }

    const sourceKey = hashContent(markdown);
    put(sourceKey, markdown, sourceLabel);

    return NextResponse.json({
      sourceKey,
      sourceLabel,
      chars: markdown.length,
      preview: markdown.slice(0, 800),
      cached: false,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
