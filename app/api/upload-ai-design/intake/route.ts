import { NextRequest, NextResponse } from "next/server";
import { markReceived } from "@/lib/upload-ai-orders";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Missing the art package." }, { status: 400 });

  const id = text(form.get("id"));
  const fields = {
    category: text(form.get("category")),
    name: text(form.get("name")),
    email: text(form.get("email")),
    message: text(form.get("message")),
  };
  const archive = form.get("archive");
  if (!id || !fields.category || !fields.name || !fields.email || !(archive instanceof File) || archive.size === 0) {
    return NextResponse.json({ error: "Missing the art package." }, { status: 400 });
  }

  let failed: string[] = [];
  const failedRaw = text(form.get("failed"));
  if (failedRaw) {
    try {
      const parsed: unknown = JSON.parse(failedRaw);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        return NextResponse.json({ error: "The failed list is invalid." }, { status: 400 });
      }
      failed = parsed;
    } catch {
      return NextResponse.json({ error: "The failed list is invalid." }, { status: 400 });
    }
  }

  const saved = markReceived(id, Buffer.from(await archive.arrayBuffer()), failed, fields);
  if (!saved) return NextResponse.json({ error: "That design is not waiting." }, { status: 404 });
  return NextResponse.json({ id, status: "received" });
}

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
