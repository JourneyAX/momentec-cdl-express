import sharp from "sharp";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateGptImageSheet, uploadToMagnific } from "./magnific";

export type ArtworkView = "front" | "back" | "left" | "right";

export const SHEET_VIEWS: ArtworkView[] = ["front", "back", "left", "right"];

const ANGLE: Record<ArtworkView, string> = {
  front: "the FRONT elevation of that one 3D garment, orthographic, straight on",
  back: "the BACK elevation of the same 3D garment, orthographic, turned 180 degrees from the front",
  left: "the LEFT elevation of the same 3D garment, a true 90 degree orthographic side. This is the side that sits on the viewer's left in the front view, and its front points toward the left edge of the cell",
  right: "the RIGHT elevation of the same 3D garment, a true 90 degree orthographic side. This is the side that sits on the viewer's right in the front view, and its front points toward the right edge of the cell",
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

  return `Redraw ONE garment as a clean 2x2 product sheet of a single 3D model. ${attached} Look at each photo and decide what it shows. A photo may be the front, the back, a side, or another photo of an angle you already have. Copy the garment type from those photos. It may be any apparel: a top, a bottom, a dress, outerwear, or anything else shown. Then render all four elevations of that same 3D garment.

The four cells are four orthographic renders of one 3D model, turned in 90 degree steps. Use the same scale, the same camera distance, the same vertical placement, and flat even lighting in every cell. No strong perspective. A side view is that model rotated, not a new garment.

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

export async function generateMissingSheet(
  references: DesignReference[],
  instruction = "",
): Promise<{ sheet: Buffer; views: Record<ArtworkView, Buffer> }> {
  if (references.length === 0) throw new Error("At least one uploaded image is required.");

  const sheet = await generateGptImageSheet(
    buildSheetPrompt(references.length, instruction),
    references.map((item) => ({ buffer: item.buffer, mimeType: item.mimeType })),
  );
  return { sheet, views: await splitSheet(sheet) };
}

const DECORATION_LIST_PROMPT = `This image is a 2x2 product sheet of one sportswear garment.
Top-left is the front. Top-right is the back. Bottom-left is the left side. Bottom-right is the right side.

Divide the applied decorations you can actually see into two groups.

teamDecoration: logos, crests, patches, and sleeve graphics that belong to the team or company. Not a player number and not a player name.
rosterDecoration: the player number and the player name only.

A mark counts only when its shape or lettering is visible. Skip the garment fabric, seams, collar, cuffs, and trim. Do not guess. If a mark is missing or too small to read, leave it out. Empty arrays are correct when that group has nothing.

One physical mark is one asset. Front and side, or back and side, often show two pieces of the same logo, number, name, or patch because the view cuts it off: partial letters, a graphic sliced at the edge, or a number only half in frame. Those pieces are the same mark. List it once, on the cell that shows the largest part. Do not list the cropped piece as its own asset. Do not invent parts that are not visible in any cell.

Also name the colors you can see.

fillColors are the garment fabric only. Not the printed marks, and not the white sheet background. primary is the main body color. second is the next fabric color only when the sleeves, side panels, or trim are a different color. third is another fabric color only when a third one is actually there. One fabric color means one entry.

Each decoration has colors: the inks in that one mark, not the fabric behind it. Include a white or light outline when it is part of the mark.

Every color has a short uppercase name for what you see, and a hex of #RRGGBB matched to the pixels in this image. Do not invent a brand palette.

Return ONLY strict JSON, no markdown fences:
{
  "fillColors": [
    { "role": "primary" | "second" | "third", "name": string, "hex": string }
  ],
  "teamDecoration": [
    { "cell": "front" | "back" | "left" | "right", "view": string, "colors": [{ "name": string, "hex": string }], "prompt": string }
  ],
  "rosterDecoration": [
    { "cell": "front" | "back" | "left" | "right", "view": string, "colors": [{ "name": string, "hex": string }], "prompt": string }
  ]
}

cell is the sheet quadrant where that mark is clearest. It is not the placement label.
view is the exact spot on the garment, uppercase, then the word SUBLIMATION. Two to four place words. Judge it from the picture: compare the mark to the collar, the hem, and the vertical midline of that panel. Use CENTER only when the mark actually sits on that midline. If it sits to one side of the chest, name that side of the chest and say UPPER or LOWER when it is not mid-torso. If it sits on a sleeve, name that sleeve. Left and right mean the wearer's left and right, not the left and right of the picture. On the front cell, the wearer's left is on the right side of that cell. A roster number ends with SUBLIMATION NUMBER. A roster name ends with SUBLIMATION NAME. Do not describe the artwork in view: no LOGO, WORDMARK, GRAPHIC, CHARACTER, CREST, or PATCH. A logo is one mark; do not list letters or icons inside it. Name the place you see. Do not reuse a fixed list of places.
prompt tells an image editor, which will also receive this same 2x2 sheet, to reproduce only that one mark. Name the whole mark and the same spot you used in view. If the chosen cell cuts it off, say to join the pieces from the neighboring cell and output the full mark, not the cropped slice. Do not invent parts that are not visible in any cell. Say to copy its shape and color exactly, centered on a plain white background with a white margin. Say not to draw the garment or any other mark.`;

export type DecorationGroup = "team" | "roster";
export type NamedColor = { name: string; hex: string };
export type FillColor = { role: "primary" | "second" | "third"; name: string; hex: string };
export type DecorationBrief = {
  group: DecorationGroup;
  view: string;
  cell: ArtworkView;
  colors: NamedColor[];
  prompt: string;
  asset?: string;
};

export type DecorationList = {
  fillColors: FillColor[];
  teamDecoration: DecorationBrief[];
  rosterDecoration: DecorationBrief[];
};

export async function listDecorations(sheet: Buffer): Promise<DecorationList> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  });
  const result = await model.generateContent([
    { text: DECORATION_LIST_PROMPT },
    { inlineData: { data: sheet.toString("base64"), mimeType: "image/png" } },
  ]);
  const raw = result.response.text();
  const parsed = JSON.parse(raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim()) as {
    fillColors?: unknown;
    teamDecoration?: unknown;
    rosterDecoration?: unknown;
  };
  const fillColors = readFillColors(parsed.fillColors);
  const briefs = [
    ...readDecorationGroup(parsed.teamDecoration, "team"),
    ...readDecorationGroup(parsed.rosterDecoration, "roster"),
  ].slice(0, 12);
  return {
    fillColors,
    teamDecoration: briefs.filter((item) => item.group === "team"),
    rosterDecoration: briefs.filter((item) => item.group === "roster"),
  };
}

function readFillColors(value: unknown): FillColor[] {
  if (!Array.isArray(value)) return [];
  const roles = new Set<FillColor["role"]>(["primary", "second", "third"]);
  const seen = new Set<FillColor["role"]>();
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const role = record.role as FillColor["role"];
    const color = readColor(record.name, record.hex);
    if (!roles.has(role) || seen.has(role) || !color) return [];
    seen.add(role);
    return [{ role, ...color }];
  }).sort((a, b) => ["primary", "second", "third"].indexOf(a.role) - ["primary", "second", "third"].indexOf(b.role));
}

function readColor(name: unknown, hex: unknown): NamedColor | null {
  if (typeof name !== "string" || typeof hex !== "string") return null;
  const label = name.trim().toUpperCase().slice(0, 40);
  const code = hex.trim();
  if (!label || !/^#[0-9A-Fa-f]{6}$/.test(code)) return null;
  return { name: label, hex: code.toUpperCase() };
}

function readDecorationGroup(value: unknown, group: DecorationGroup): DecorationBrief[] {
  if (!Array.isArray(value)) return [];
  const cells = new Set<ArtworkView>(SHEET_VIEWS);
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .flatMap((item) => {
      const view = typeof item.view === "string" ? item.view.trim().slice(0, 80) : "";
      const prompt = typeof item.prompt === "string" ? item.prompt.trim().slice(0, 800) : "";
      const cell = item.cell as ArtworkView;
      if (!view || !prompt || !cells.has(cell) || isEmptyMark(view, prompt)) return [];
      const colors = Array.isArray(item.colors)
        ? item.colors.flatMap((color) => {
            if (typeof color !== "object" || color === null) return [];
            const record = color as Record<string, unknown>;
            const named = readColor(record.name, record.hex);
            return named ? [named] : [];
          }).slice(0, 8)
        : [];
      return [{ group, view, cell, colors, prompt }];
    });
}

function isEmptyMark(label: string, prompt: string): boolean {
  const head = `${label} ${prompt.slice(0, 160)}`;
  return /\b(none|n\/a|unknown|not visible|no logo|no number|no name|no patch|cannot (see|find|identify)|can't (see|find|identify)|unsure)\b/i.test(head);
}

const VIEW_CELL: Record<ArtworkView, string> = {
  front: "top-left",
  back: "top-right",
  left: "bottom-left",
  right: "bottom-right",
};

function viewPrompt(view: ArtworkView): string {
  return `The attached image is a 2x2 product sheet of one sportswear garment. Redraw only the ${view} view from the ${VIEW_CELL[view]} cell. One garment, full length, centered on a plain white background, with an even white margin on every side. Copy its shape, colors, and marks exactly. Do not draw the other cells, the white cross, a caption, or a second garment.`;
}

export type ExtractedDecorations = DecorationList & { images: Map<string, Buffer> };

export async function extractDecorations(sheet: Buffer): Promise<ExtractedDecorations> {
  const listed = await listDecorations(sheet);
  const used = new Set<string>();
  const briefs = [...listed.teamDecoration, ...listed.rosterDecoration].map((brief, index) => ({
    ...brief,
    asset: assetFilename(brief, index, used),
  }));
  const apiKey = process.env.MAGNIFIC_API_KEY;
  if (!apiKey) throw new Error("MAGNIFIC_API_KEY is not set.");
  const referenceUrl = await uploadToMagnific(apiKey, sheet, "image/png");
  const jobs = [
    ...SHEET_VIEWS.map((view) => ({
      name: `${view}.png`,
      prompt: viewPrompt(view),
      aspectRatio: "traditional_3_4",
      dropIfWhite: false,
    })),
    ...briefs.map((brief) => ({
      name: brief.asset,
      prompt: `${brief.prompt}\nThe attached image is the 2x2 sheet. Reproduce only this one mark. It is clearest in the ${brief.cell} cell. If that cell cuts it off, complete it from the neighboring cell where the same mark continues. Its placement is ${brief.view}. Output the full mark, not a cropped fragment.`,
      aspectRatio: "square_1_1",
      dropIfWhite: true,
    })),
  ];
  const images = new Map<string, Buffer>();
  const midpoint = Math.ceil(jobs.length / 2);
  const waves = [jobs.slice(0, midpoint), jobs.slice(midpoint)].filter((wave) => wave.length > 0);
  for (const wave of waves) {
    const batch = await Promise.all(
      wave.map(async (job) => {
        const png = await generateGptImageSheet(job.prompt, [{ buffer: sheet, mimeType: "image/png" }], {
          aspectRatio: job.aspectRatio,
          referenceUrls: [referenceUrl],
        });
        if (job.dropIfWhite && (await isMostlyWhite(png))) return null;
        return { name: job.name, png };
      }),
    );
    for (const item of batch) {
      if (item) images.set(item.name, item.png);
    }
  }
  return {
    fillColors: listed.fillColors,
    teamDecoration: briefs.filter((item) => item.group === "team"),
    rosterDecoration: briefs.filter((item) => item.group === "roster"),
    images,
  };
}

function assetFilename(brief: DecorationBrief, index: number, used: Set<string>): string {
  const stem = `${brief.group}-${brief.view}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  let name = `${stem || `mark-${index + 1}`}.png`;
  let suffix = 2;
  while (used.has(name)) {
    name = `${stem}-${suffix}.png`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

async function isMostlyWhite(buffer: Buffer): Promise<boolean> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  let ink = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * info.channels;
    if (isGarmentPixel(data[offset], data[offset + 1], data[offset + 2])) ink += 1;
  }
  return ink / pixels < 0.01;
}
