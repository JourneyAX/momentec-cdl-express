import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { get, list, put } from "@vercel/blob";
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

type ListedOrder = Omit<DesignOrder, "zip"> & { ready: boolean };

const BLOB_PREFIX = "cdl-express/upload-ai-design/orders";

const globalStore = globalThis as typeof globalThis & {
  __uploadAiOrders?: Map<string, DesignOrder>;
};

function usesBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function orders(): Map<string, DesignOrder> {
  if (!globalStore.__uploadAiOrders) globalStore.__uploadAiOrders = new Map();
  return globalStore.__uploadAiOrders;
}

function orderKey(id: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return id;
}

function listed(order: DesignOrder): ListedOrder {
  const { zip, ...rest } = order;
  return { ...rest, ready: Boolean(zip) };
}

async function readStoredOrder(id: string): Promise<ListedOrder | null> {
  const file = await get(`${BLOB_PREFIX}/${id}.json`, { access: "private" });
  if (!file || file.statusCode !== 200) return null;
  return JSON.parse(await new Response(file.stream).text()) as ListedOrder;
}

async function writeStoredOrder(order: ListedOrder): Promise<void> {
  await put(`${BLOB_PREFIX}/${order.id}.json`, JSON.stringify(order), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export async function createOrder(id: string, fields: DesignFields): Promise<DesignOrder> {
  const order: DesignOrder = {
    id,
    ...fields,
    status: "waiting",
    failed: [],
    error: "",
    createdAt: new Date().toISOString(),
  };
  if (usesBlob()) await writeStoredOrder(listed(order));
  else orders().set(id, order);
  return order;
}

export async function listOrders(): Promise<ListedOrder[]> {
  if (usesBlob()) {
    const result = await list({ prefix: `${BLOB_PREFIX}/`, limit: 1000 });
    const records = await Promise.all(
      result.blobs.filter((blob) => blob.pathname.endsWith(".json")).map(async (blob) => {
        const file = await get(blob.pathname, { access: "private" });
        if (!file || file.statusCode !== 200) return null;
        return JSON.parse(await new Response(file.stream).text()) as ListedOrder;
      }),
    );
    return records.filter((order): order is ListedOrder => Boolean(order)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  return [...orders().values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((order) => listed(order));
}

export async function orderZip(id: string): Promise<{ filename: string; zip: Buffer } | null> {
  const key = orderKey(id);
  if (!key) return null;
  if (usesBlob()) {
    const file = await get(`${BLOB_PREFIX}/${key}.zip`, { access: "private" });
    if (!file || file.statusCode !== 200) return null;
    return { filename: `${key}.zip`, zip: Buffer.from(await new Response(file.stream).arrayBuffer()) };
  }
  const order = orders().get(key);
  if (!order?.zip) return null;
  return { filename: `${order.id}.zip`, zip: order.zip };
}

export async function markReceived(id: string, zip: Buffer, failed: string[], fields: DesignFields): Promise<boolean> {
  const key = orderKey(id);
  if (!key) return false;
  if (usesBlob()) {
    const order = await readStoredOrder(key);
    if (!order) return false;
    await put(`${BLOB_PREFIX}/${key}.zip`, zip, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/zip",
    });
    await writeStoredOrder({
      ...order,
      ...fields,
      status: "received",
      failed,
      error: "",
      ready: true,
    });
    return true;
  }
  const order = orders().get(key);
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

export async function markFailed(id: string, error: string): Promise<void> {
  const key = orderKey(id);
  if (!key) return;
  if (usesBlob()) {
    const order = await readStoredOrder(key);
    if (!order || order.status === "received") return;
    await writeStoredOrder({ ...order, status: "failed", error, ready: false });
    return;
  }
  const order = orders().get(key);
  if (!order || order.status === "received") return;
  order.status = "failed";
  order.error = error;
}

function userUploadRoot(): string {
  if (process.env.VERCEL || process.env.K_SERVICE) return path.join(os.tmpdir(), "assets", "user-uploaded");
  return path.join(process.cwd(), "assets", "user-uploaded");
}

export async function saveUserUploads(id: string, uploads: UserUpload[]): Promise<void> {
  if (uploads.length === 0) return;
  const folder = path.join(userUploadRoot(), id);
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
  model?: Buffer,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const source of sources) {
    zip.file(`${source.view}.${IMAGE_EXT[source.mimeType] ?? "png"}`, source.buffer);
  }
  for (const file of files) zip.file(file.filename, file.svg);
  for (const upload of uploads) zip.file(`user-uploaded/${upload.filename}`, upload.buffer);
  if (model) zip.file("model.glb", model);
  zip.file(
    "order.json",
    JSON.stringify({ ...fields, failed, uploads: uploads.map((upload) => upload.filename), model: model ? "model.glb" : null }, null, 2),
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
