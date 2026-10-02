import { after, NextRequest, NextResponse } from "next/server";
import { buildAssetSvgs, type AssetSource } from "@/lib/upload-ai-assets";
import { buildAssetZip, createOrder, markFailed, saveUserUploads, uploadFilename, type DesignFields, type UserUpload } from "@/lib/upload-ai-orders";
import { SHEET_VIEWS } from "@/lib/upload-ai-sheet";

export const runtime = "nodejs";
export const maxDuration = 300;

const MIME: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
};

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Upload the four views first." }, { status: 400 });

  const fields: DesignFields = {
    category: text(form.get("category")),
    name: text(form.get("name")),
    email: text(form.get("email")),
    message: text(form.get("message")),
  };
  if (!fields.category || !fields.name || !fields.email) {
    return NextResponse.json({ error: "Category, name, and email are required." }, { status: 400 });
  }

  const sources: AssetSource[] = [];
  for (const view of SHEET_VIEWS) {
    const value = form.get(view);
    if (!(value instanceof File) || value.size === 0) continue;
    const mimeType = MIME[value.type];
    if (!mimeType) return NextResponse.json({ error: "Use a jpg, png, or webp image." }, { status: 400 });
    sources.push({ view, buffer: Buffer.from(await value.arrayBuffer()), mimeType });
  }
  if (sources.length < SHEET_VIEWS.length) {
    return NextResponse.json({ error: "Make the four views before uploading the design." }, { status: 400 });
  }

  const uploads: UserUpload[] = [];
  for (const value of form.getAll("upload")) {
    if (!(value instanceof File) || value.size === 0) continue;
    if (!MIME[value.type]) return NextResponse.json({ error: "Use a jpg, png, or webp image." }, { status: 400 });
    uploads.push({
      filename: uploadFilename(value.name, uploads.length),
      buffer: Buffer.from(await value.arrayBuffer()),
    });
  }

  const modelFile = form.get("model");
  const model = modelFile instanceof File && modelFile.size > 0 ? Buffer.from(await modelFile.arrayBuffer()) : undefined;

  const id = crypto.randomUUID();
  createOrder(id, fields);
  await saveUserUploads(id, uploads);
  const origin = req.nextUrl.origin;
  after(() => deliver(origin, id, fields, sources, uploads, model));
  return NextResponse.json({ id }, { status: 202 });
}

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

async function deliver(origin: string, id: string, fields: DesignFields, sources: AssetSource[], uploads: UserUpload[], model?: Buffer): Promise<void> {
  try {
    const { files, failed } = await buildAssetSvgs(sources);
    if (files.length === 0) {
      markFailed(id, "Magnific did not return vector SVG files.");
      return;
    }
    const zip = await buildAssetZip(sources, files, fields, failed, uploads, model);
    const body = new FormData();
    body.set("id", id);
    body.set("category", fields.category);
    body.set("name", fields.name);
    body.set("email", fields.email);
    body.set("message", fields.message);
    body.set("failed", JSON.stringify(failed));
    body.set("archive", new Blob([new Uint8Array(zip)], { type: "application/zip" }), `${id}.zip`);
    const response = await fetch(`${origin}/api/upload-ai-design/intake`, { method: "POST", body });
    if (!response.ok) markFailed(id, "The art package could not be delivered.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not prepare the art files.";
    console.error("upload-ai-design submit failed:", message);
    markFailed(id, message === "Magnific MCP credentials are not configured." ? message : "Could not prepare the art files.");
  }
}
