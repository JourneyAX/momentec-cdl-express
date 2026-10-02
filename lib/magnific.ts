// Magnific API client for the CDL Express "Prepare artwork" step: cleans up
// the customer's uploaded design photo (background removal, and a faithful
// precision upscale if the source is low-resolution) before it's used for
// style matching and 3D baking.
//
// Scope note: prepareArtwork touches the flat 2D reference photo only
// (background removal + a faithful upscale). It does NOT vectorize the
// design or produce cut-piece geometry. generateGptImageSheet is a separate
// call used by the upload-design 2x2 sheet flow.
//
// Same key source + honest-fallback pattern as lib/gemini.ts: if
// MAGNIFIC_API_KEY isn't set, or any call fails/times out, we fall back to
// the customer's original, untouched image rather than blocking the flow.
//
// Confirmed against the live docs (https://docs.magnific.com) and verified
// with real API calls against https://api.magnific.com before wiring this in:
//
//   POST /v1/ai/beta/remove-background   (application/x-www-form-urlencoded)
//     body: image_url (must be a URL Magnific's servers can fetch - no
//     base64/data-URI support; confirmed by a live 400 "Either path or url
//     is required" response when a data: URI was tried)
//     -> 200 synchronously: { original, high_resolution, preview, url }
//     high_resolution/url are temporary download links, valid 5 minutes only
//     - this client downloads immediately rather than persisting the link.
//
//   Upload Files API (https://docs.magnific.com/upload-files) - solves the
//   "Magnific can't fetch my localhost URL" problem by staging the bytes on
//   Magnific's own storage and handing back a URL THEY host, which is what
//   we then pass as image_url to remove-background:
//
//   POST /v1/ai/uploads/request-url   (application/json)
//     body: { files: [{ content_type: "image/png" | "image/jpeg" | "image/webp" }] }
//     -> 200: { files: [{ file_id, upload_url, headers, expires_in, asset_url, asset_url_expires_in }] }
//     upload_url is short-lived (expires_in seconds) - PUT right away.
//     asset_url is a Magnific-hosted, publicly-fetchable URL, valid ~24h
//     (asset_url_expires_in), and is what we can safely pass to any endpoint
//     that takes an image_url - including from local dev.
//
//   PUT <upload_url>   (raw bytes, echoing the `headers` from the response
//     above verbatim - they're part of the URL signature; no API key here,
//     the signed URL itself is the auth)
//
//   POST /v1/ai/image-upscaler            (application/json)
//     body: { image: <base64>, scale_factor, creativity, engine, ... }
//     creativity is a signed [-10, 10] scale (not a separate mode/engine
//     param) - negative values are the "Precision" behaviour (faithful
//     upscale, no invented detail), which is what we want here.
//     -> 200 async: { data: { task_id, status: CREATED, generated: [] } }
//   GET  /v1/ai/image-upscaler/{task_id}
//     -> { data: { task_id, status, error, generated: [url] } }
//     status cycles CREATED -> IN_PROGRESS -> COMPLETED | FAILED.

const BASE_URL = "https://api.magnific.com";

// Below this on the long edge, the source photo is treated as low-resolution
// and gets a precision upscale before we hand it off to style matching / bake.
const LONG_EDGE_UPSCALE_THRESHOLD = 1500;

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface PrepareArtworkResult {
  status: "prepared" | "skipped_no_key" | "skipped_error";
  buffer: Buffer;
  mimeType: string;
  backgroundRemoved: boolean;
  upscaled: boolean;
  originalDimensions: ImageDimensions | null;
  finalDimensions: ImageDimensions | null;
  message: string;
}

/**
 * Minimal, dependency-free PNG/JPEG/WebP dimension sniffer - just enough to
 * decide whether the image needs an upscale before spending an API call on
 * it. Returns null if the format isn't recognized or parsing fails; callers
 * treat that as "unknown" and skip the upscale decision rather than guessing.
 */
export function getImageDimensions(buffer: Buffer): ImageDimensions | null {
  try {
    // PNG: 8-byte signature, then the IHDR chunk holds width/height at
    // bytes 16-23 (big-endian, 4 bytes each).
    if (
      buffer.length >= 24 &&
      buffer.readUInt32BE(0) === 0x89504e47 &&
      buffer.readUInt32BE(4) === 0x0d0a1a0a
    ) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    // JPEG: walk markers looking for a SOFn segment (0xFFC0-0xFFCF, excluding
    // C4/C8/CC which are DHT/JPG/DAC, not start-of-frame).
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          offset += 2;
          continue;
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + segmentLength;
      }
      return null;
    }

    // WebP: RIFF container. Lossy (VP8 ) and lossless (VP8L) chunks encode
    // dimensions differently; extended (VP8X) carries them directly.
    if (
      buffer.length >= 30 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      const chunkId = buffer.toString("ascii", 12, 16);
      if (chunkId === "VP8X") {
        const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
        const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
        return { width, height };
      }
      if (chunkId === "VP8 ") {
        const dataStart = 20; // 12-byte RIFF header + 4-byte fourCC + 4-byte chunk size
        if (buffer[dataStart + 3] === 0x9d && buffer[dataStart + 4] === 0x01 && buffer[dataStart + 5] === 0x2a) {
          const width = (buffer[dataStart + 6] | (buffer[dataStart + 7] << 8)) & 0x3fff;
          const height = (buffer[dataStart + 8] | (buffer[dataStart + 9] << 8)) & 0x3fff;
          return { width, height };
        }
      }
      if (chunkId === "VP8L") {
        const dataStart = 20;
        if (buffer[dataStart] === 0x2f) {
          const b = buffer.readUInt32LE(dataStart + 1);
          return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

interface RequestUploadUrlResponse {
  files: Array<{
    file_id: string;
    upload_url: string;
    headers: Record<string, string>;
    expires_in: number;
    asset_url: string;
    asset_url_expires_in: number;
  }>;
}

/**
 * Stages a local image buffer on Magnific's own storage via the Upload Files
 * API (https://docs.magnific.com/upload-files) and returns the resulting
 * `asset_url` - a URL Magnific's servers themselves host and can therefore
 * always fetch, unlike a localhost URL from this app in dev. Two-step flow:
 * request a pre-signed upload_url + asset_url, then PUT the raw bytes to
 * upload_url (echoing its `headers` verbatim - they're part of the URL
 * signature). The API key is only used for step 1; step 2 is authorized by
 * the signed URL itself.
 */
export async function uploadToMagnific(
  apiKey: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const requestRes = await fetch(`${BASE_URL}/v1/ai/uploads/request-url`, {
    method: "POST",
    headers: { "x-magnific-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ content_type: mimeType }] }),
  });
  if (!requestRes.ok) {
    const text = await requestRes.text().catch(() => "");
    throw new Error(`uploads/request-url failed (${requestRes.status}): ${text.slice(0, 300)}`);
  }
  const requestData: RequestUploadUrlResponse = await requestRes.json();
  const file = requestData.files[0];
  if (!file) throw new Error("uploads/request-url returned no files.");

  const putRes = await fetch(file.upload_url, {
    method: "PUT",
    headers: file.headers,
    body: new Uint8Array(buffer),
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`upload PUT failed (${putRes.status}): ${text.slice(0, 300)}`);
  }

  return file.asset_url;
}

interface RemoveBackgroundResponse {
  original: string;
  high_resolution: string;
  preview: string;
  url: string;
}

async function callRemoveBackground(apiKey: string, imageUrl: string): Promise<RemoveBackgroundResponse> {
  const res = await fetch(`${BASE_URL}/v1/ai/beta/remove-background`, {
    method: "POST",
    headers: {
      "x-magnific-api-key": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ image_url: imageUrl }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`remove-background failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

interface UpscaleTaskResponse {
  data: {
    task_id: string;
    status: "CREATED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
    error: string | null;
    generated: string[];
  };
}

async function startUpscale(apiKey: string, base64Image: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/ai/image-upscaler`, {
    method: "POST",
    headers: { "x-magnific-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      image: base64Image,
      scale_factor: "2x",
      // Precision, not Creative: creativity is a signed [-10, 10] dial, not a
      // separate mode param - the most negative value is the faithful,
      // nothing-invented behaviour this step needs (we're prepping a
      // customer's own artwork, not generating new detail on top of it).
      creativity: -10,
      engine: "automatic",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`image-upscaler failed to start (${res.status}): ${text.slice(0, 300)}`);
  }
  const data: UpscaleTaskResponse = await res.json();
  return data.data.task_id;
}

async function pollUpscale(apiKey: string, taskId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/v1/ai/image-upscaler/${taskId}`, {
      headers: { "x-magnific-api-key": apiKey },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`image-upscaler status check failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data: UpscaleTaskResponse = await res.json();
    if (data.data.status === "COMPLETED" && data.data.generated[0]) return data.data.generated[0];
    if (data.data.status === "FAILED") {
      throw new Error(`image-upscaler task failed: ${data.data.error || "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("image-upscaler task did not complete within the timeout.");
}

const GPT_EDIT_POLL_MS = 150_000;

export async function generateGptImageSheet(
  prompt: string,
  references: { buffer: Buffer; mimeType: string }[],
): Promise<Buffer> {
  const apiKey = process.env.MAGNIFIC_API_KEY;
  if (!apiKey) throw new Error("MAGNIFIC_API_KEY is not set.");
  if (references.length === 0) throw new Error("At least one reference image is required.");

  const referenceImages = await Promise.all(
    references.map((reference) => uploadToMagnific(apiKey, reference.buffer, reference.mimeType)),
  );

  const res = await fetch(`${BASE_URL}/v1/ai/text-to-image/gpt-image-2-edit`, {
    method: "POST",
    headers: { "x-magnific-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      reference_images: referenceImages,
      num_images: 1,
      resolution: "1k",
      aspect_ratio: "traditional_3_4",
      quality: "low",
      output_format: "png",
      background: "opaque",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gpt-image-2-edit failed to start (${res.status}): ${text.slice(0, 300)}`);
  }
  const started: UpscaleTaskResponse = await res.json();
  const url = await pollGptImageEdit(apiKey, started.data.task_id);
  return downloadBuffer(url);
}

async function pollGptImageEdit(apiKey: string, taskId: string): Promise<string> {
  const deadline = Date.now() + GPT_EDIT_POLL_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/v1/ai/text-to-image/gpt-image-2-edit/${taskId}`, {
      headers: { "x-magnific-api-key": apiKey },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gpt-image-2-edit status check failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data: UpscaleTaskResponse = await res.json();
    if (data.data.status === "COMPLETED" && data.data.generated[0]) return data.data.generated[0];
    if (data.data.status === "FAILED") {
      throw new Error(`gpt-image-2-edit task failed: ${data.data.error || "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("gpt-image-2-edit task did not complete within the timeout.");
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download prepared image (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Cleans up a customer's uploaded reference photo: removes the background,
 * then - only if the result is still low-resolution - runs a faithful
 * (precision/low-creativity) upscale. remove-background has no base64/upload
 * alternative - it needs a URL Magnific's own servers can fetch - so this
 * first stages `imageBuffer` via the Upload Files API (`uploadToMagnific`)
 * to get a Magnific-hosted, publicly-fetchable asset_url, which works
 * regardless of whether this app itself is reachable (e.g. running on
 * localhost in dev, not yet deployed).
 */
export async function prepareArtwork(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<PrepareArtworkResult> {
  const apiKey = process.env.MAGNIFIC_API_KEY;
  const originalDimensions = getImageDimensions(imageBuffer);

  if (!apiKey) {
    return {
      status: "skipped_no_key",
      buffer: imageBuffer,
      mimeType,
      backgroundRemoved: false,
      upscaled: false,
      originalDimensions,
      finalDimensions: originalDimensions,
      message:
        "Artwork prep is unavailable (MAGNIFIC_API_KEY is not set in this app's .env). Continuing with your original photo, untouched.",
    };
  }

  try {
    // Magnific's remove-background endpoint needs a URL its own servers can
    // fetch. `sourceUrl` is built from this app's own request origin, which
    // in local dev is localhost - unreachable from Magnific's side. Stage
    // the original bytes on Magnific's own storage first and use the
    // asset_url it hands back instead; this also works unchanged once the
    // app is deployed behind a real public origin (it's just an extra hop).
    const fetchableUrl = await uploadToMagnific(apiKey, imageBuffer, mimeType);
    const removed = await callRemoveBackground(apiKey, fetchableUrl);
    // The returned URLs are valid for 5 minutes only - download right away.
    let buffer = await downloadBuffer(removed.high_resolution);
    let dims = getImageDimensions(buffer) || originalDimensions;
    let upscaled = false;
    const notes: string[] = ["Background removed."];

    const longEdge = dims ? Math.max(dims.width, dims.height) : Infinity;
    if (longEdge < LONG_EDGE_UPSCALE_THRESHOLD) {
      try {
        const taskId = await startUpscale(apiKey, buffer.toString("base64"));
        const generatedUrl = await pollUpscale(apiKey, taskId);
        buffer = await downloadBuffer(generatedUrl);
        dims = getImageDimensions(buffer) || dims;
        upscaled = true;
        notes.push("Upscaled (precision mode, faithful to the original - no invented detail).");
      } catch (upscaleErr) {
        // Background removal already succeeded; don't throw that work away
        // just because the upscale step failed or timed out.
        notes.push(
          `Upscale skipped: ${upscaleErr instanceof Error ? upscaleErr.message : "unknown error"}.`,
        );
      }
    }

    return {
      status: "prepared",
      buffer,
      mimeType: "image/png",
      backgroundRemoved: true,
      upscaled,
      originalDimensions,
      finalDimensions: dims,
      message: notes.join(" "),
    };
  } catch (err) {
    return {
      status: "skipped_error",
      buffer: imageBuffer,
      mimeType,
      backgroundRemoved: false,
      upscaled: false,
      originalDimensions,
      finalDimensions: originalDimensions,
      message: `Artwork prep failed (${err instanceof Error ? err.message : "unknown error"}). Continuing with your original photo, untouched.`,
    };
  }
}
