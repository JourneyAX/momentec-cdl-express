import { NextRequest } from "next/server";
import { buildProofPdf } from "@/lib/upload-ai-proof-pdf";
import { extractDecorations } from "@/lib/upload-ai-sheet";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: "Make the four views first." }, { status: 400 });

  const sheetFile = form.get("sheet");
  if (!(sheetFile instanceof File) || sheetFile.size === 0) {
    return Response.json({ error: "Make the four views first." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: { progress?: number; pdf?: string; error?: string }) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      try {
        send({ progress: 2 });
        const extracted = await extractDecorations(Buffer.from(await sheetFile.arrayBuffer()), (progress) => {
          send({ progress });
        });
        send({ progress: 96 });
        const pdf = await buildProofPdf(extracted, extracted.images);
        send({ progress: 100, pdf: pdf.toString("base64") });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not make the proof.";
        console.error("upload-ai-design proof failed:", message);
        const missing = message === "MAGNIFIC_API_KEY is not set." || message === "GEMINI_API_KEY is not set.";
        const credits = message.startsWith("Magnific could not charge credits");
        send({ error: missing || credits ? message : "Could not make the proof." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
