import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";

const PAGE_W = 612;
const PAGE1_H = 900;
const LETTER_H = 792;
const BLUE = "#1A78C2";
const CYAN = "#1A9BC7";
const INK = "#1A1A1A";
const MUTED = "#5C6770";
const MARGIN = 22;
const LINE = "#D3DCE3";
const PANEL = "#F3F7FA";
const RED = "#E10600";
const HARD_BG = "#F8D0D0";

export const PROOF_ORDER = {
  ref: "S6071854",
  ecom: "65486587642357",
  style: "228435",
  design: "CUSTOM (STRIKEOUT)",
  size: "MOCKUP",
  qty: "1",
  artist: "MQ",
  playerNo: "10",
  playerName: "PLAYER",
  comment:
    "Can you please recreate this youth jersey for this ladies jerseys? Customer used the wrong SKU when they created their jersey on the builder and the strike out template isn't available for the softball jersey. Thank you!",
  commentUrl:
    "https://www.momentecbrands.com/Configurator?sNumber=S60679448-pin=d1b428eda384fa1e45b925e499ed930e&itemId=316009&styleID=228237",
  artistNote: "USE CUSTOM FUZE PAD PRINT // USAR PAD PRINT DE CUSTOM FUZE",
};

export type ProofColor = { name: string; hex: string };
export type ProofFill = { role: string; name: string; hex: string };
export type ProofDecoration = { group?: string; view: string; colors?: ProofColor[]; asset?: string };
export type ProofSource = {
  fillColors?: ProofFill[];
  teamDecoration?: ProofDecoration[];
  rosterDecoration?: ProofDecoration[];
};

export function decorationAssetName(group: string, view: string): string {
  const stem = `${group}-${view}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${stem || "mark"}.png`;
}

const VIEW_PX = 500;
const MARK_W = 340;
const MARK_H = 140;

export async function buildProofPdf(json: ProofSource, images: Map<string, Buffer>): Promise<Buffer> {
  const [header, front, back, left, right, marks] = await Promise.all([
    loadHeader(),
    prepareView(images.get("front.png")),
    prepareView(images.get("back.png")),
    prepareView(images.get("left.png")),
    prepareView(images.get("right.png")),
    fitMarks(json, images),
  ]);
  const views = { front, back, left, right };
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_W, PAGE1_H], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    drawProof(doc, json, marks, views, header);
    doc.end();
  });
}

function drawProof(
  doc: PDFKit.PDFDocument,
  json: ProofSource,
  images: Map<string, Buffer>,
  views: Record<"front" | "back" | "left" | "right", Buffer | null>,
  header: Buffer | null,
) {
  paintPage(doc, PAGE1_H);
  drawHeader(doc, header);
  drawSummary(doc, views, json.fillColors ?? []);
  doc.addPage({ size: "LETTER", margin: 0 });
  paintPage(doc, LETTER_H);
  drawHeader(doc, header);
  drawDecorations(doc, json, images, header);
  doc.addPage({ size: "LETTER", margin: 0 });
  paintPage(doc, LETTER_H);
  drawHeader(doc, header);
  drawRosterPage(doc);
}

function paintPage(doc: PDFKit.PDFDocument, pageH: number) {
  doc.rect(0, 0, PAGE_W, pageH).fill("#FFFFFF");
  doc.rect(14, 10, PAGE_W - 28, pageH - 20).lineWidth(0.7).strokeColor("#C5CED6").stroke();
  doc.rect(MARGIN, 58, PAGE_W - MARGIN * 2, pageH - 74).fill(PANEL);
}

function drawHeader(doc: PDFKit.PDFDocument, header: Buffer | null) {
  const x = 18;
  const w = PAGE_W - 36;
  if (header) {
    doc.image(header, x, 14, { width: w, height: 40 });
    return;
  }
  doc.rect(x, 18, w, 28).fill(BLUE);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(12).text("FreeStyle", x, 26, {
    width: w,
    align: "center",
    lineBreak: false,
  });
}

function drawSummary(
  doc: PDFKit.PDFDocument,
  views: Record<"front" | "back" | "left" | "right", Buffer | null>,
  fills: ProofFill[],
) {
  doc.font("Helvetica-Bold").fontSize(13);
  const summary = "ORDER SUMMARY";
  const divider = "  |  ";
  const custom = "CUSTOM DESIGN";
  const summaryW = doc.widthOfString(summary);
  const dividerW = doc.widthOfString(divider);
  const customW = doc.widthOfString(custom);
  const titleX = (PAGE_W - (summaryW + dividerW + customW)) / 2;
  doc.fillColor("#111111").text(summary, titleX, 68, { lineBreak: false });
  doc.fillColor(RED).text(divider.trim(), titleX + summaryW + 4, 68, { lineBreak: false });
  doc.text(custom, titleX + summaryW + dividerW, 68, { lineBreak: false });

  doc.font("Helvetica-Bold").fontSize(8).fillColor(CYAN).text("ORDER INFO :", MARGIN + 10, 94, { lineBreak: false });
  doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("ARTIST:", 470, 94, { lineBreak: false });
  hardText(doc, PROOF_ORDER.artist, 508, 92, { size: 10, font: "Helvetica-Bold" });

  const info: [string, string][] = [
    ["REF#:", PROOF_ORDER.ref],
    ["Total Quantity:", PROOF_ORDER.qty],
    ["Ecom Order#:", PROOF_ORDER.ecom],
  ];
  info.forEach(([label, value], index) => {
    const y = 112 + index * 14;
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(label, MARGIN + 10, y, { lineBreak: false });
    hardText(doc, value, 160, y);
  });

  const slots = [views.front, views.back, views.left, views.right];
  const imageW = 250;
  const imageH = 250;
  const originX = 46;
  const originY = 168;
  slots.forEach((image, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = originX + col * (imageW + 20);
    const y = originY + row * (imageH + 8);
    if (image) doc.image(image, x, y, { fit: [imageW, imageH], align: "center", valign: "center" });
  });

  const infoY = 692;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(CYAN).text("GARMENT INFO:", MARGIN + 10, infoY, { lineBreak: false });
  const garment: [string, string][] = [
    ["STYLE # :", PROOF_ORDER.style],
    ["SIZE :", PROOF_ORDER.size],
    ["QTY :", PROOF_ORDER.qty],
  ];
  garment.forEach(([label, value], index) => {
    const y = infoY + 18 + index * 14;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text(label, MARGIN + 10, y, { lineBreak: false });
    hardText(doc, value, 140, y);
  });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text("DESIGN:", 300, infoY + 18, { lineBreak: false });
  hardText(doc, PROOF_ORDER.design, 360, infoY + 18);

  const fillY = 770;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(CYAN).text("FILL COLORS:", MARGIN + 10, fillY, { lineBreak: false });
  fills.forEach((fill, index) => {
    const y = fillY + 20 + index * 18;
    const role = `${fill.role.toUpperCase()}:`;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text(role, MARGIN + 10, y, { lineBreak: false });
    drawSwatch(doc, 168, y - 2, fill.hex);
    doc.font("Helvetica").fontSize(8).fillColor(INK).text(fill.name, 186, y, { lineBreak: false });
  });
}

function drawDecorations(doc: PDFKit.PDFDocument, json: ProofSource, images: Map<string, Buffer>, header: Buffer | null) {
  let y = 68;
  y = drawSection(doc, y, "TEAM/COMPANY DECORATION", header);
  for (const item of json.teamDecoration ?? []) y = drawDecorationRow(doc, y, item, "team", images, header);
  y += 6;
  y = drawSection(doc, y, "ROSTER DECORATION:", header);
  for (const item of json.rosterDecoration ?? []) y = drawDecorationRow(doc, y, item, "roster", images, header);
}

function drawSection(doc: PDFKit.PDFDocument, y: number, title: string, header: Buffer | null): number {
  const top = ensureSpace(doc, y, 24, header);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(CYAN).text(title, MARGIN + 6, top, { lineBreak: false });
  return top + 16;
}

function drawDecorationRow(
  doc: PDFKit.PDFDocument,
  y: number,
  item: ProofDecoration,
  group: string,
  images: Map<string, Buffer>,
  header: Buffer | null,
): number {
  const height = 78;
  const top = ensureSpace(doc, y, height + 4, header);
  const x = MARGIN + 4;
  const w = PAGE_W - MARGIN * 2 - 8;
  doc.roundedRect(x, top, w, height, 2).fill("#FFFFFF");
  doc.roundedRect(x, top, w, height, 2).lineWidth(0.6).strokeColor(LINE).stroke();

  doc.font("Helvetica-Bold").fontSize(6.5).fillColor(INK);
  doc.text(item.view, x + 6, top + 6, { width: 108, lineGap: -1 });
  hardText(doc, "ADJ: U:0  D:0  L:0  R:0", x + 6, top + 46, { size: 5.5, color: MUTED });
  hardText(doc, specLine(item.view), x + 6, top + 56, { size: 5.5, color: MUTED });

  const image = images.get(item.asset || decorationAssetName(item.group || group, item.view));
  if (image) doc.image(image, x + 130, top + 4, { fit: [170, height - 8], align: "center", valign: "center" });

  const colors = item.colors ?? [];
  colors.forEach((color, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const sx = x + 320 + col * 120;
    const sy = top + 10 + row * 16;
    drawSwatch(doc, sx, sy, color.hex);
    doc.font("Helvetica").fontSize(6.5).fillColor(INK).text(color.name, sx + 14, sy + 2, {
      width: 100,
      lineBreak: false,
    });
  });
  return top + height + 5;
}

function specLine(view: string): string {
  if (view.endsWith("NUMBER")) return "SENTINEL: 1.5 INCH";
  if (view.endsWith("NAME")) return "FULL BLOCK: 1.5 INCH";
  return "ART HEIGHT: 1.5 INCH    ART WIDTH: 1.5 INCH";
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, height: number, header: Buffer | null): number {
  if (y + height <= LETTER_H - 20) return y;
  doc.addPage({ size: "LETTER", margin: 0 });
  paintPage(doc, LETTER_H);
  drawHeader(doc, header);
  return 68;
}

function drawRosterPage(doc: PDFKit.PDFDocument) {
  doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("ROSTER INFORMATION", MARGIN + 8, 70, { lineBreak: false });
  const headers = ["STYLE:", "NO:", "NAME:", "TOP SIZE:", "QTY:"];
  const values = [PROOF_ORDER.style, PROOF_ORDER.playerNo, PROOF_ORDER.playerName, PROOF_ORDER.size, PROOF_ORDER.qty];
  const columns = [MARGIN + 28, 150, 240, 370, 490];
  headers.forEach((header, index) => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text(header, columns[index], 96, { lineBreak: false });
  });
  const tableX = MARGIN + 8;
  const tableW = PAGE_W - MARGIN * 2 - 16;
  doc.rect(tableX, 112, tableW, 22).lineWidth(0.6).strokeColor(LINE).stroke();
  doc.moveTo(columns[4] - 12, 112).lineTo(columns[4] - 12, 134).strokeColor(LINE).lineWidth(0.6).stroke();
  values.forEach((value, index) => {
    hardText(doc, value, columns[index], 118);
  });

  doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("COMMENTS FROM CUSTOMER:", MARGIN + 8, 152, { lineBreak: false });
  doc.moveTo(MARGIN + 8, 168).lineTo(PAGE_W - MARGIN - 8, 168).strokeColor(LINE).lineWidth(0.6).stroke();
  const boxW = PAGE_W - MARGIN * 2 - 32;
  hardText(doc, PROOF_ORDER.comment, MARGIN + 8, 178, { width: boxW });
  hardText(doc, PROOF_ORDER.commentUrl, MARGIN + 8, 214, { size: 7, color: CYAN, width: boxW });
}

function hardText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  options: { size?: number; font?: string; color?: string; width?: number } = {},
) {
  const size = options.size ?? 8;
  const font = options.font ?? "Helvetica";
  doc.font(font).fontSize(size);
  const boxW = options.width ?? doc.widthOfString(text) + 2;
  const boxH = options.width ? doc.heightOfString(text, { width: options.width }) : size + 2;
  doc.save();
  doc.rect(x - 1, y - 1, boxW + 2, boxH + 2).fill(HARD_BG);
  doc.restore();
  doc.font(font).fontSize(size).fillColor(options.color ?? INK);
  if (options.width) doc.text(text, x, y, { width: options.width });
  else doc.text(text, x, y, { lineBreak: false });
}

function drawSwatch(doc: PDFKit.PDFDocument, x: number, y: number, hex: string) {
  const color = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : "#CCCCCC";
  const white = color.toUpperCase() === "#FFFFFF";
  doc.save();
  doc.circle(x + 5, y + 5, 5);
  if (white) doc.lineWidth(0.8).strokeColor("#B7BFC6").stroke();
  else doc.fill(color);
  doc.restore();
}

async function prepareView(buffer: Buffer | undefined): Promise<Buffer | null> {
  return knockOutWhite(await fitPng(buffer, VIEW_PX, VIEW_PX));
}

async function fitMarks(json: ProofSource, images: Map<string, Buffer>): Promise<Map<string, Buffer>> {
  const fitted = new Map<string, Buffer>();
  const items = [...(json.teamDecoration ?? []), ...(json.rosterDecoration ?? [])];
  await Promise.all(
    items.map(async (item) => {
      const name = item.asset || decorationAssetName(item.group || "team", item.view);
      const png = await fitPng(images.get(name), MARK_W, MARK_H);
      if (png) fitted.set(name, png);
    }),
  );
  return fitted;
}

async function fitPng(buffer: Buffer | undefined, width: number, height: number): Promise<Buffer | null> {
  if (!buffer) return null;
  return sharp(buffer).resize(width, height, { fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
}

async function loadHeader(): Promise<Buffer | null> {
  const file = path.join(process.cwd(), "assets/pdf1.png");
  if (!existsSync(file)) return null;
  return sharp(file).extract({ left: 0, top: 20, width: 614, height: 48 }).png().toBuffer();
}

async function knockOutWhite(buffer: Buffer | null): Promise<Buffer | null> {
  if (!buffer) return null;
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * info.channels;
    if (data[offset] > 245 && data[offset + 1] > 245 && data[offset + 2] > 245) data[offset + 3] = 0;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}
