import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ArtworkView } from "./upload-ai-sheet";

const MCP_URL = "https://mcp.magnific.com/mcp";
const TOKEN_URL = "https://auth.magnific.com/realms/mcp/protocol/openid-connect/token";
const MODEL = process.env.MAGNIFIC_MCP_MODEL || "imagen-nano-banana-2";
const POLL_TIMEOUT_MS = 90_000;
const PROMPT_LIMIT = 3000;

export type AssetSource = { view: ArtworkView; buffer: Buffer; mimeType: string };

type SheetJob = {
  filename: string;
  name: string;
  aspectRatio: "1:1" | "3:4";
  prompt: string;
};

const SHEETS: SheetJob[] = [
  {
    filename: "elements.svg",
    name: "Element sheet",
    aspectRatio: "1:1",
    prompt:
      "Create a clean flat 2D sheet from the supplied garment views. Isolate every visible logo, wordmark, crest, badge, number, name, stripe, and trim as separate non-overlapping items on pure white. Preserve the colors and outlines that are actually there. Do not draw a garment, a person, fabric folds, or a background scene. Include only marks that are visible in the supplied views.",
  },
  {
    filename: "alphabet.svg",
    name: "Alphabet sheet",
    aspectRatio: "1:1",
    prompt:
      "Create a flat typography sheet from the lettering visible on the supplied garment views. First show the names and numbers that are actually there. Then draw a separate 0-9 and A-Z reference in that same style. Pure white background. No garment, person, or scene.",
  },
  {
    filename: "print-panel.svg",
    name: "Print panel",
    aspectRatio: "3:4",
    prompt:
      "Create flat print art from the continuous artwork visible on the supplied garment views. Remove the garment silhouette, seams, collars, sleeves, folds, shadows, and any person. If more than one print area is visible, place each area as its own panel with white space between panels. Do not invent a new scene.",
  },
  {
    filename: "primary-logo.svg",
    name: "Primary logo",
    aspectRatio: "1:1",
    prompt:
      "Isolate only the dominant logo, script, or crest visible on the supplied garment views. Draw it flat on pure white and keep its colors, outlines, and proportions. No garment, person, fabric, or shadow.",
  },
];

export function assertPathSvg(content: string, label: string): string {
  const markup = content.toLowerCase();
  if (!markup.includes("<svg")) throw new Error(`${label} did not return an SVG.`);
  if (markup.includes("<image") || markup.includes("data:image")) {
    throw new Error(`${label} embedded a bitmap instead of vector paths.`);
  }
  if (!markup.includes("<path")) throw new Error(`${label} did not include vector paths.`);
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function resultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  for (const block of result.content) {
    if (isRecord(block) && typeof block.text === "string") return block.text;
  }
  return "";
}

function structured(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return {};
  return result.structuredContent;
}

function parseJsonText(result: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(resultText(result) || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function creationIdentifier(result: unknown): string | null {
  const data = structured(result);
  const textData = parseJsonText(result);
  const creations = Array.isArray(data.creations) ? data.creations : Array.isArray(textData.creations) ? textData.creations : [];
  const first = creations[0];
  if (isRecord(first) && typeof first.identifier === "string") return first.identifier;
  if (typeof data.identifier === "string") return data.identifier;
  if (typeof textData.identifier === "string") return textData.identifier;
  if (isRecord(data.creation) && typeof data.creation.identifier === "string") return data.creation.identifier;
  if (isRecord(textData.creation) && typeof textData.creation.identifier === "string") return textData.creation.identifier;
  return resultText(result).match(/"identifier"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

async function accessToken(): Promise<string> {
  if (process.env.MAGNIFIC_MCP_ACCESS_TOKEN) return process.env.MAGNIFIC_MCP_ACCESS_TOKEN;
  const clientId = process.env.MAGNIFIC_MCP_CLIENT_ID;
  const refreshToken = process.env.MAGNIFIC_MCP_REFRESH_TOKEN;
  if (!clientId || !refreshToken) throw new Error("Magnific MCP credentials are not configured.");

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (process.env.MAGNIFIC_MCP_CLIENT_SECRET) form.set("client_secret", process.env.MAGNIFIC_MCP_CLIENT_SECRET);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Magnific authentication failed (${response.status}).`);
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Magnific authentication did not return an access token.");
  return payload.access_token;
}

async function mcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${await accessToken()}` } },
  });
  const client = new Client({ name: "momentec-upload-ai-assets", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function uploadSource(client: Client, source: AssetSource): Promise<string> {
  const request = await client.callTool({
    name: "creations_request_upload",
    arguments: { mimeType: source.mimeType },
  });
  const requestData = { ...parseJsonText(request), ...structured(request) };
  const uploadUrl = typeof requestData.proxyUploadUrl === "string" ? requestData.proxyUploadUrl : null;
  const uploadPath = typeof requestData.path === "string" ? requestData.path : null;
  if (!uploadUrl || !uploadPath) throw new Error(`Magnific did not create an upload slot for the ${source.view} view.`);

  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": source.mimeType },
    body: new Uint8Array(source.buffer),
    signal: AbortSignal.timeout(60_000),
  });
  if (!uploaded.ok) throw new Error(`Magnific upload failed for the ${source.view} view (${uploaded.status}).`);

  const finalized = await client.callTool({
    name: "creations_finalize_upload",
    arguments: { path: uploadPath, visible: false },
  });
  const identifier = creationIdentifier(finalized);
  if (!identifier) throw new Error(`Magnific did not return an identifier for the ${source.view} view.`);
  return identifier;
}

async function waitForCreation(client: Client, identifier: string, label: string, timeoutMs: number | null = POLL_TIMEOUT_MS): Promise<void> {
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  while (deadline === null || Date.now() < deadline) {
    const response = await client.callTool({
      name: "creations_wait",
      arguments: { identifiers: [identifier], timeoutSeconds: 25 },
    });
    const data = structured(response);
    const results = Array.isArray(data.results) ? data.results : [];
    const match = results.find((item) => isRecord(item) && item.identifier === identifier) ?? results[0];
    if (isRecord(match)) {
      if (match.status === "completed") return;
      if (match.status === "failed" || match.status === "error") throw new Error(`${label} failed in Magnific.`);
    }
    const text = resultText(response);
    if (/"status"\s*:\s*"completed"/.test(text)) return;
    if (/status\s*[:=]\s*["']?(failed|error)/i.test(text)) throw new Error(`${label} failed in Magnific.`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`${label} timed out.`);
}

async function creationUrl(client: Client, identifier: string, missing = "Magnific did not return an SVG download URL."): Promise<string> {
  const response = await client.callTool({
    name: "creations_wait",
    arguments: { identifiers: [identifier], timeoutSeconds: 25 },
  });
  const data = structured(response);
  const results = Array.isArray(data.results) ? data.results : [];
  const match = results.find((item) => isRecord(item) && item.identifier === identifier) ?? results[0];
  if (isRecord(match) && isRecord(match.results) && typeof match.results.url === "string") return match.results.url;
  const url = resultText(response).match(/"url"\s*:\s*"(https?:\/\/[^"\\]+)"/)?.[1];
  if (!url) throw new Error(missing);
  return url;
}

async function generateSheet(client: Client, job: SheetJob, referenceIds: string[]): Promise<string> {
  const response = await client.callTool({
    name: "images_generate",
    arguments: {
      mode: MODEL,
      prompt: job.prompt.slice(0, PROMPT_LIMIT),
      aspectRatio: job.aspectRatio,
      references: referenceIds.map((identifier) => ({ type: "image", identifier })),
      count: 1,
    },
  });
  const identifier = creationIdentifier(response);
  if (!identifier) throw new Error(`Magnific did not queue ${job.name}.`);
  await waitForCreation(client, identifier, job.name);
  return identifier;
}

async function vectorize(client: Client, rasterId: string, label: string): Promise<string> {
  const queued = await client.callTool({
    name: "images_to_svg",
    arguments: { creationIdentifier: rasterId },
  });
  const identifier = creationIdentifier(queued);
  if (!identifier) throw new Error(`Magnific did not queue SVG conversion for ${label}.`);
  await waitForCreation(client, identifier, `${label} SVG`);
  const response = await fetch(await creationUrl(client, identifier), { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`Unable to download the ${label} SVG (${response.status}).`);
  return assertPathSvg(await response.text(), label);
}

export async function buildAssetSvgs(sources: AssetSource[]): Promise<{ files: { filename: string; svg: string }[]; failed: string[] }> {
  if (sources.length === 0) throw new Error("At least one generated view is required.");
  const client = await mcpClient();
  const referenceIds: string[] = [];
  for (const source of sources) referenceIds.push(await uploadSource(client, source));

  const files: { filename: string; svg: string }[] = [];
  const failed: string[] = [];
  for (const job of SHEETS) {
    try {
      const rasterId = await generateSheet(client, job, referenceIds);
      files.push({ filename: job.filename, svg: await vectorize(client, rasterId, job.name) });
    } catch (error) {
      console.error(`upload-ai asset ${job.filename} failed:`, error instanceof Error ? error.message : error);
      failed.push(job.filename);
    }
  }
  return { files, failed };
}

export async function buildGarmentModel(sources: AssetSource[]): Promise<Buffer> {
  const byView = new Map(sources.map((source) => [source.view, source]));
  const ordered = (["front", "left", "back", "right"] as const).map((view) => byView.get(view));
  if (ordered.some((source) => !source)) throw new Error("Make the four views before opening the 3D view.");

  const client = await mcpClient();
  const views: Record<string, string> = {};
  for (const source of ordered) {
    if (!source) continue;
    views[source.view] = await uploadSource(client, source);
  }
  const response = await client.callTool({
    name: "models3d_generate",
    arguments: {
      model: "tripo-v31",
      views,
      textureQuality: "standard",
      faceLimit: 50000,
    },
  });
  const identifier = creationIdentifier(response);
  if (!identifier) throw new Error("Magnific did not queue the 3D view.");
  await waitForCreation(client, identifier, "3D view", null);
  const download = await fetch(await creationUrl(client, identifier, "Magnific did not return a 3D model."), {
    signal: AbortSignal.timeout(60_000),
  });
  if (!download.ok) throw new Error(`Unable to download the 3D model (${download.status}).`);
  return Buffer.from(await download.arrayBuffer());
}
