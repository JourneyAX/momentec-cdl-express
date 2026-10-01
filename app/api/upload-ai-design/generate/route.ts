import { NextRequest, NextResponse } from "next/server";
import { generateMissingSheet, SHEET_VIEWS, type SheetReference } from "@/lib/upload-ai-sheet";
import type { ArtworkView } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const MIME: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
};

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Upload at least one view." }, { status: 400 });

  const supplied: SheetReference[] = [];
  for (const view of SHEET_VIEWS) {
    const value = form.get(view);
    if (!(value instanceof File) || value.size === 0) continue;
    const mimeType = MIME[value.type];
    if (!mimeType) return NextResponse.json({ error: "Use a jpg, png, or webp image." }, { status: 400 });
    supplied.push({ view, buffer: Buffer.from(await value.arrayBuffer()), mimeType });
  }

  if (supplied.length === 0) {
    return NextResponse.json({ error: "At least one uploaded view is required." }, { status: 400 });
  }

  try {
    const images = await generateMissingSheet(supplied);
    const encoded: Partial<Record<ArtworkView, string>> = {};
    for (const view of SHEET_VIEWS) {
      const png = images[view];
      if (png) encoded[view] = png.toString("base64");
    }
    return NextResponse.json({ images: encoded });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate the other views.";
    console.error("upload-ai-design generate failed:", message);
    const status = message === "GEMINI_API_KEY is not set." ? 503 : 502;
    const safe = status === 503 ? message : "Could not generate the other views.";
    return NextResponse.json({ error: safe }, { status });
  }
}
