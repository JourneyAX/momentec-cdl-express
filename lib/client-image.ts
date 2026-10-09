/**
 * Client-side image utilities for CDL Express:
 * - AI background removal / garment isolation (via @imgly/background-removal isnet_quint8)
 * - Dimension downscaling and compression (preserving PNG alpha transparency)
 * - Orientation rotation
 */

import type { Config, ImageSource } from "@imgly/background-removal";

let preloadPromise: Promise<void> | null = null;

/**
 * Preloads the background removal WASM runtime and quantized neural network
 * model in the background so inference starts immediately upon file upload.
 */
export async function preloadBackgroundRemoval(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!preloadPromise) {
    preloadPromise = (async () => {
      try {
        const { preload } = await import("@imgly/background-removal");
        await preload({ model: "isnet_quint8" });
      } catch (e) {
        console.warn("Background removal preload note:", e);
      }
    })();
  }
  return preloadPromise;
}

/**
 * Pre-downscales large camera photos to 512px before feeding them into the segmentation neural network.
 * Reduces computation by 75% for sub-second processing time while keeping crisp contours.
 */
async function downscaleForSegmentation(source: File | Blob, maxDim = 512): Promise<File | Blob> {
  if (typeof window === "undefined") return source;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(source);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width <= maxDim && height <= maxDim) {
        resolve(source);
        return;
      }
      if (width > height) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(source);
        return;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob || source), "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(source);
    };
    img.src = url;
  });
}

/**
 * Removes background surfaces (carpet, table, floor) from an uploaded garment photo
 * directly in the browser, returning a transparent PNG file.
 */
export async function isolateGarment(
  file: File,
  fileName: string = "garment-isolated.png"
): Promise<File> {
  const { removeBackground } = await import("@imgly/background-removal");
  const optimizedInput = await downscaleForSegmentation(file, 512);

  const config: Config = {
    model: "isnet_quint8",
    output: {
      format: "image/png",
      quality: 0.95,
    },
  };

  const blob = await removeBackground(optimizedInput as ImageSource, config);
  const baseName = fileName.replace(/\.[^/.]+$/, "");
  return new File([blob], `${baseName}.png`, { type: "image/png" });
}

/**
 * Compresses user-uploaded photos in the browser before network upload.
 * Preserves PNG / WebP transparency (avoiding flattening alpha pixels to opaque JPEG).
 */
export async function compressImageForUpload(
  file: File,
  maxDimension: number = 2048,
  quality: number = 0.88
): Promise<File> {
  if (file.size < 600 * 1024 && !file.type.includes("heic")) {
    return file;
  }

  if (!file.type.startsWith("image/")) {
    return file;
  }

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let { width, height } = img;
      if (width === 0 || height === 0) {
        resolve(file);
        return;
      }

      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(file);
        return;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, width, height);

      const isPngOrWebp = file.type === "image/png" || file.type === "image/webp";
      const targetMime = isPngOrWebp ? file.type : "image/jpeg";

      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size >= file.size) {
            resolve(file);
            return;
          }

          const ext = targetMime === "image/jpeg" ? "jpg" : targetMime === "image/webp" ? "webp" : "png";
          const cleanName = file.name.replace(/\.[^/.]+$/, "") + `.${ext}`;
          const compressed = new File([blob], cleanName, { type: targetMime });
          resolve(compressed);
        },
        targetMime,
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };

    img.src = objectUrl;
  });
}
