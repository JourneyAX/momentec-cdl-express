import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { AssetSource } from "./upload-ai-assets";

export type UserUpload = { filename: string; buffer: Buffer };

export type DesignFields = {
  category: string;
  name: string;
  email: string;
  message: string;
};

export type OrderStatus = "waiting" | "received" | "failed";

export type DesignOrder = DesignFields & {
  id: string;
  status: OrderStatus;
  failed: string[];
  error: string;
  createdAt: string;
  zip?: Buffer;
};

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const globalStore = globalThis as typeof globalThis & {
  __uploadAiOrders?: Map<string, DesignOrder>;
};

function orders(): Map<string, DesignOrder> {
  if (!globalStore.__uploadAiOrders) globalStore.__uploadAiOrders = new Map();
  return globalStore.__uploadAiOrders;
}

export function createOrder(id: string, fields: DesignFields): DesignOrder {
  const order: DesignOrder = {
    id,
    ...fields,
    status: "waiting",
    failed: [],
    error: "",
    createdAt: new Date().toISOString(),
  };
  orders().set(id, order);
  return order;
}

export function listOrders(): Array<Omit<DesignOrder, "zip"> & { ready: boolean }> {
  return [...orders().values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(({ zip, ...order }) => ({ ...order, ready: Boolean(zip) }));
}

export function orderZip(id: string): { filename: string; zip: Buffer } | null {
  const order = orders().get(id);
  if (!order?.zip) return null;
  return { filename: `${order.id}.zip`, zip: order.zip };
}

export function markReceived(id: string, zip: Buffer, failed: string[], fields: DesignFields): boolean {
  const order = orders().get(id);
  if (!order) return false;
  order.status = "received";
  order.zip = zip;
  order.failed = failed;
  order.error = "";
  order.category = fields.category;
  order.name = fields.name;
  order.email = fields.email;
  order.message = fields.message;
  return true;
}

export function markFailed(id: string, error: string): void {
  const order = orders().get(id);
  if (!order || order.status === "received") return;
  order.status = "failed";
  order.error = error;
}

export async function saveUserUploads(id: string, uploads: UserUpload[]): Promise<void> {
  if (uploads.length === 0) return;
  const folder = path.join(process.cwd(), "assets", "user-uploaded", id);
  await mkdir(folder, { recursive: true });
  for (const upload of uploads) {
    await writeFile(path.join(folder, upload.filename), upload.buffer);
  }
}

export function uploadFilename(name: string, index: number): string {
  const base = path.basename(name).replace(/[^\w.-]/g, "_").replace(/^\.+/, "");
  const safe = /\.(jpe?g|png|webp)$/i.test(base) ? base : `upload-${index + 1}.png`;
  return `${index + 1}-${safe}`;
}

export async function buildAssetZip(
  sources: AssetSource[],
  files: { filename: string; svg: string }[],
  fields: DesignFields,
  failed: string[],
  uploads: UserUpload[] = [],
): Promise<Buffer> {
  const zip = new JSZip();
  for (const source of sources) {
    zip.file(`${source.view}.${IMAGE_EXT[source.mimeType] ?? "png"}`, source.buffer);
  }
  for (const file of files) zip.file(file.filename, file.svg);
  for (const upload of uploads) zip.file(`user-uploaded/${upload.filename}`, upload.buffer);
  zip.file("order.json", JSON.stringify({ ...fields, failed, uploads: uploads.map((upload) => upload.filename) }, null, 2));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
