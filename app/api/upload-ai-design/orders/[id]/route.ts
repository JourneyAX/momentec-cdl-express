import { NextResponse } from "next/server";
import { orderZip } from "@/lib/upload-ai-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const packed = orderZip(id);
  if (!packed) return NextResponse.json({ error: "That package is not ready." }, { status: 404 });
  return new NextResponse(new Uint8Array(packed.zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${packed.filename}"`,
    },
  });
}
