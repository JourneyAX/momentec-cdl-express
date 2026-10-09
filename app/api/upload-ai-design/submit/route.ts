import { NextRequest, NextResponse } from "next/server";
import { buildProofPdf } from "@/lib/upload-ai-proof-pdf";
import { extractDecorations } from "@/lib/upload-ai-sheet";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Make the four views first." }, { status: 400 });

  const sheetFile = form.get("sheet");
  if (!(sheetFile instanceof File) || sheetFile.size === 0) {
    return NextResponse.json({ error: "Make the four views first." }, { status: 400 });
  }

  try {
    const extracted = await extractDecorations(Buffer.from(await sheetFile.arrayBuffer()));
    const pdf = await buildProofPdf(extracted, extracted.images);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="proof.pdf"',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not make the proof.";
    console.error("upload-ai-design proof failed:", message);
    const missing = message === "MAGNIFIC_API_KEY is not set." || message === "GEMINI_API_KEY is not set.";
    const credits = message.startsWith("Magnific could not charge credits");
    return NextResponse.json(
      { error: missing || credits ? message : "Could not make the proof." },
      { status: missing ? 503 : 502 },
    );
  }
}
