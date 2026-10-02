import sharp from "sharp";
import { generateGptImageSheet } from "./magnific";
import type { ArtworkView } from "./types";

export const SHEET_VIEWS: ArtworkView[] = ["front", "back", "left", "right"];

const ANGLE: Record<ArtworkView, string> = {
  front: "the FRONT of the garment, viewed straight on",
  back: "the BACK of the garment, viewed straight on, 180 degrees from the front",
  left: "the side of the empty garment that sits on the viewer's left in the front photo, as a true 90 degree profile, with nobody wearing it. Its front points toward the left edge of the cell",
  right: "the side of the empty garment that sits on the viewer's right in the front photo, as a true 90 degree profile, with nobody wearing it. Its front points toward the right edge of the cell",
};

export interface DesignReference {
  buffer: Buffer;
  mimeType: string;
}

export function buildSheetPrompt(referenceCount: number, instruction = ""): string {
  const note = instruction.replace(/\s+/g, " ").trim().slice(0, 400);
  const labeled = note.length > 0 && referenceCount === 4;
  const names = Array.from({ length: referenceCount }, (_, index) => `Image ${index + 1}`).join(", ");
  const attached = labeled
    ? "Image 1 is the current front, Image 2 is the current back, Image 3 is the current left, and Image 4 is the current right."
    : referenceCount === 1
      ? `${names} is an unordered reference of one garment.`
      : `${names} are unordered references of one garment. They are not in any particular order.`;
  const edit = note
    ? `\nLook-and-feel edit, apply it in every cell: ${note}\nKeep the same garment and the same angles. Change only what was asked.\n`
    : "";
  const sameness = note
    ? "- Keep the garment's construction and full length. Change the look only where the edit asks for a change."
    : "- Same colors, materials, pattern, and scale in every cell. If a pattern wraps the garment, continue it around the form. A mark that appears on only one face stays on that face. Do not invent new marks.";

  return `Redraw ONE garment as a clean 2x2 product sheet. ${attached} Look at each photo and decide what it shows. A photo may be the front, the back, a side, or another photo of an angle you already have. Copy the garment type from those photos. It may be any apparel: a top, a bottom, a dress, outerwear, or anything else shown. Then draw all four views of that same garment.

Sheet layout, exactly one garment in each cell:
- Top-left cell: ${ANGLE.front}. One garment.
- Top-right cell: ${ANGLE.back}. One garment.
- Bottom-left cell: ${ANGLE.left}. One garment.
- Bottom-right cell: ${ANGLE.right}. One garment.

The references are evidence, not cell assignments. Do not paste a photo into a cell with a caption. Redraw every cell, including an angle that a reference already shows, so all four match.
${edit}
Hard rules:
- Each cell contains exactly one garment. Never draw two garments, a pair of profiles, or two angles together in one cell.
- Keep the construction that is visible in the references: silhouette, openings, closures, length, and every part that is actually there. Do not add parts that are not there, and do not remove parts that are.
- Plain white background in every cell. Draw a wide plain white cross through the exact center, horizontal and vertical, about one tenth of the sheet wide. No garment may touch or cross that white cross. No black background, no colored backdrop, and no shadow.
- Draw each garment at full length, the same length as the reference, from its top edge to its bottom edge. The front and the back must include the bottom edge. Do not crop them, zoom in, or end them early. Leave a clear band of white under that bottom edge, before the white cross, and between the garment and the outer edge of its cell.
- Do not draw any text, captions, parentheses, or view names. Marks that are already printed on the garment stay on the fabric.
${sameness}
- The garment is empty. No person, mannequin, hanger, or body. Do not draw skin, a face, neck, chin, arms, or hands above, inside, or beside the garment.

Output only the image.`;
}

function isGarmentPixel(red: number, green: number, blue: number): boolean {
  return red < 245 || green < 245 || blue < 245;
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
    left: { left: 0, top: gapY.end, width: gapX.start, height: height - gapY.end },
    right: { left: gapX.end, top: gapY.end, width: width - gapX.end, height: height - gapY.end },
  };

  const entries = await Promise.all(
    SHEET_VIEWS.map(async (view) => {
      const png = await sharp(buffer).extract(boxes[view]).png().toBuffer();
      return [view, png] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<ArtworkView, Buffer>;
}

export async function generateMissingSheet(references: DesignReference[], instruction = ""): Promise<Record<ArtworkView, Buffer>> {
  if (references.length === 0) throw new Error("At least one uploaded image is required.");

  const sheet = await generateGptImageSheet(
    buildSheetPrompt(references.length, instruction),
    references.map((item) => ({ buffer: item.buffer, mimeType: item.mimeType })),
  );
  return splitSheet(sheet);
}
