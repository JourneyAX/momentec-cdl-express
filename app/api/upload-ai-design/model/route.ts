import { NextRequest, NextResponse } from "next/server";
import { buildGarmentModel, type AssetSource } from "@/lib/upload-ai-assets";
import { SHEET_VIEWS } from "@/lib/upload-ai-sheet";

export const runtime = "nodejs";
export const maxDuration = 20000;

const MIME: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
};

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Make the four views before opening the 3D view." }, { status: 400 });

  const sources: AssetSource[] = [];
  for (const view of SHEET_VIEWS) {
    const value = form.get(view);
    if (!(value instanceof File) || value.size === 0) continue;
    const mimeType = MIME[value.type];
    if (!mimeType) return NextResponse.json({ error: "Use a jpg, png, or webp image." }, { status: 400 });
    sources.push({ view, buffer: Buffer.from(await value.arrayBuffer()), mimeType });
  }
  if (sources.length < SHEET_VIEWS.length) {
    return NextResponse.json({ error: "Make the four views before opening the 3D view." }, { status: 400 });
  }

  try {
    const model = await buildGarmentModel(sources);
    return new NextResponse(new Uint8Array(model), {
      headers: {
        "Content-Type": "model/gltf-binary",
        "Content-Disposition": 'attachment; filename="model.glb"',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not make the 3D view.";
    console.error("upload-ai-design model failed:", message);
    const missing = message === "Magnific MCP credentials are not configured.";
    return NextResponse.json({ error: missing ? message : "Could not make the 3D view." }, { status: missing ? 503 : 502 });
  }
}
