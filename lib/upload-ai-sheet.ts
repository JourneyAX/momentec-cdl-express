import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from "sharp";
import type { ArtworkView } from "./types";

const IMAGE_MODEL = "gemini-3-pro-image";

export const SHEET_VIEWS: ArtworkView[] = ["front", "back", "left", "right"];

const CELL: Record<ArtworkView, string> = {
  front: "top-left cell",
  back: "top-right cell",
  left: "bottom-right cell",
  right: "bottom-left cell",
};

const ANGLE: Record<ArtworkView, string> = {
  front: "the FRONT of the garment, viewed straight on",
  back: "the BACK of the garment, viewed straight on, 180 degrees from the front",
  left: "the empty garment's LEFT side as a true 90 degree profile, with nobody wearing it. In a front photo, that side is the one on the viewer's right",
  right: "the empty garment's RIGHT side as a true 90 degree profile, with nobody wearing it. In a front photo, that side is the one on the viewer's left",
};

export interface SheetReference {
  view: ArtworkView;
  buffer: Buffer;
  mimeType: string;
}

export function buildSheetPrompt(supplied: ArtworkView[], missing: ArtworkView[]): string {
  const suppliedLines = supplied
    .map((view) => `- ${view.toUpperCase()} is attached. It is the source of truth for that angle. Redraw it in the ${CELL[view]} so it matches the other three cells. Do not paste the photo in with a caption.`)
    .join("\n");
  const missingLines = missing
    .map((view) => `- ${CELL[view]} is not attached. Create ${ANGLE[view]}.`)
    .join("\n");
  const oneSideOnly =
    supplied.includes("left") !== supplied.includes("right") &&
    (missing.includes("left") || missing.includes("right"));
  const contrast = oneSideOnly
    ? "\nOne side was supplied and the other was not. The missing side is the opposite panel. Do not copy or mirror a mark that appears only on the supplied side.\n"
    : "";

  return `Redraw ONE garment as a clean 2x2 product sheet. The attached photos are references, labeled REFERENCE VIEW. Copy the garment type from those photos. It may be any apparel: a top, a bottom, a dress, outerwear, or anything else shown. Every cell is a new drawing of that same garment, including the angles that were uploaded, so all four match.

Sheet layout, exactly one garment in each cell:
- Top-left cell: the front, straight on. One garment.
- Top-right cell: the back, straight on. One garment.
- Bottom-left cell: the garment's right side. One empty garment in profile, with its front pointing toward the left edge of the cell.
- Bottom-right cell: the garment's left side. One empty garment in profile, with its front pointing toward the right edge of the cell. The side that sits on the viewer's right in the front photo belongs in this cell.

Attached references:
${suppliedLines}

Angles that were not uploaded:
${missingLines}
${contrast}
Hard rules:
- Each cell contains exactly one garment. Never draw two garments, a pair of profiles, or two angles together in one cell.
- Keep the construction that is visible in the references: silhouette, openings, closures, length, and every part that is actually there. Do not add parts that are not there, and do not remove parts that are.
- Plain white background in every cell and in the space between cells. No black background, no colored backdrop, and no shadow.
- Keep every garment fully inside its own cell, with empty white space around it. Show the whole garment in each view, from its top edge to its bottom edge, at the same scale.
- Do not draw any text, captions, parentheses, or view names. Marks that are already printed on the garment stay on the fabric.
- Same colors, materials, pattern, and scale in every cell. If a pattern wraps the garment, continue it around the form. A mark that appears on only one face stays on that face. Do not invent new marks.
- The garment is empty. No person, mannequin, hanger, or body. Do not draw skin, a face, neck, chin, arms, or hands above, inside, or beside the garment.

Output only the image.`;
}

function isGarmentPixel(red: number, green: number, blue: number): boolean {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  return max - min > 28 && max > 45;
}

function contentFlags(data: Buffer, width: number, height: number, channels: number, axis: "row" | "column"): boolean[] {
  const count = axis === "row" ? height : width;
  const span = axis === "row" ? width : height;
  const flags = new Array<boolean>(count).fill(false);
  for (let index = 0; index < count; index += 1) {
    let ink = 0;
    for (let step = 0; step < span; step += 1) {
      const x = axis === "row" ? step : index;
      const y = axis === "row" ? index : step;
      const offset = (y * width + x) * channels;
      if (isGarmentPixel(data[offset], data[offset + 1], data[offset + 2])) ink += 1;
    }
    flags[index] = ink / span >= 0.012;
  }
  return flags;
}

function splitGap(flags: boolean[], size: number): { start: number; end: number } {
  const minThickness = Math.max(8, Math.floor(size * 0.03));
  const groups: { start: number; end: number }[] = [];
  let index = 0;
  while (index < size) {
    if (!flags[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < size && flags[index]) index += 1;
    if (index - start >= minThickness) groups.push({ start, end: index });
  }
  const halfway = Math.floor(size / 2);
  let best = { start: halfway, end: halfway };
  let bestDistance = Infinity;
  for (let group = 0; group < groups.length - 1; group += 1) {
    const start = groups[group].end;
    const end = groups[group + 1].start;
    if (end - start < 2) continue;
    const mid = (start + end) / 2;
    if (mid < size * 0.2 || mid > size * 0.8) continue;
    const distance = Math.abs(mid - size / 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { start, end };
    }
  }
  return best;
}

export async function splitSheet(buffer: Buffer): Promise<Record<ArtworkView, Buffer>> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const gapX = splitGap(contentFlags(data, width, height, channels, "column"), width);
  const gapY = splitGap(contentFlags(data, width, height, channels, "row"), height);
  const boxes = {
    front: { left: 0, top: 0, width: gapX.start, height: gapY.start },
    back: { left: gapX.end, top: 0, width: width - gapX.end, height: gapY.start },
    left: { left: gapX.end, top: gapY.end, width: width - gapX.end, height: height - gapY.end },
    right: { left: 0, top: gapY.end, width: gapX.start, height: height - gapY.end },
  };

  const entries = await Promise.all(
    SHEET_VIEWS.map(async (view) => {
      const png = await sharp(buffer).extract(boxes[view]).png().toBuffer();
      return [view, png] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<ArtworkView, Buffer>;
}

export async function generateMissingSheet(supplied: SheetReference[]): Promise<Partial<Record<ArtworkView, Buffer>>> {
  if (supplied.length === 0) throw new Error("At least one uploaded view is required.");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");

  const suppliedViews = supplied.map((item) => item.view);
  const missing = SHEET_VIEWS.filter((view) => !suppliedViews.includes(view));
  if (missing.length === 0) return {};

  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: IMAGE_MODEL });
  const parts = [
    { text: buildSheetPrompt(suppliedViews, missing) },
    ...supplied.flatMap((item) => [
      { text: `REFERENCE VIEW: ${item.view.toUpperCase()}` },
      { inlineData: { data: item.buffer.toString("base64"), mimeType: item.mimeType } },
    ]),
  ];
  const result = await model.generateContent(parts);
  const candidateParts = result.response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = candidateParts.find((part) => "inlineData" in part && part.inlineData?.data);
  const data = imagePart && "inlineData" in imagePart ? imagePart.inlineData?.data : undefined;
  if (!data) throw new Error("Gemini did not return an image.");

  return splitSheet(Buffer.from(data, "base64"));
}
