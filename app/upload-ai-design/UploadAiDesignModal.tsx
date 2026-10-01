"use client";

import { FormEvent, MouseEvent, useEffect, useRef, useState } from "react";
import { compressImageForUpload, isolateGarment, preloadBackgroundRemoval } from "@/lib/client-image";
import "./upload-ai-design.css";

const ACCEPT = ".jpg,.jpeg,.png,.webp";
const ACCEPT_RE = /\.(jpe?g|png|webp)$/i;

const VIEWS = [
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];
type ViewFile = { file: File; url: string; ready: boolean };
type ViewMap = Record<ViewId, ViewFile | null>;
type ProcessingMap = Partial<Record<ViewId, boolean>>;

const EMPTY_VIEWS: ViewMap = { front: null, back: null, left: null, right: null };

const CATEGORIES = [
  "CORPORATE APPAREL",
  "ACCESSORIES",
  "BASEBALL",
  "BASKETBALL",
  "BOTTOMS",
  "CHEER",
  "FLEECE",
  "FOOTBALL",
  "HOCKEY",
  "LACROSSE",
  "MULTI-SPORT",
  "POLOS",
  "PULLOVERS",
  "SOCCER",
  "SOFTBALL",
  "TEES",
  "TOP",
  "TOPS",
  "TRACK & FIELD",
  "VOLLEYBALL",
];

function categoryLabel(value: string) {
  return value.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function pngFile(id: ViewId, base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], `${id}-generated.png`, { type: "image/png" });
}

function filledLabels(views: ViewMap) {
  const labels = VIEWS.filter((view) => views[view.id]).map((view) => view.label.toLowerCase());
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function UploadAiDesignModal() {
  const [open, setOpen] = useState(true);
  const [views, setViews] = useState<ViewMap>(EMPTY_VIEWS);
  const [fileError, setFileError] = useState("");
  const [dragOver, setDragOver] = useState<ViewId | null>(null);
  const [processing, setProcessing] = useState<ProcessingMap>({});
  const [generating, setGenerating] = useState(false);
  const [category, setCategory] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const viewsRef = useRef(views);
  const cutoutToken = useRef<Partial<Record<ViewId, number>>>({});
  viewsRef.current = views;

  useEffect(() => {
    return () => {
      for (const view of Object.values(viewsRef.current)) {
        if (view) URL.revokeObjectURL(view.url);
      }
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      preloadBackgroundRemoval().catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function clearViews() {
    for (const view of Object.values(viewsRef.current)) {
      if (view) URL.revokeObjectURL(view.url);
    }
    setViews(EMPTY_VIEWS);
  }

  function reopen() {
    setSubmitted(false);
    clearViews();
    setFileError("");
    setCategory("");
    setOpen(true);
  }

  function replaceView(id: ViewId, file: File, ready: boolean) {
    const url = URL.createObjectURL(file);
    setViews((current) => {
      const previous = current[id];
      if (previous) URL.revokeObjectURL(previous.url);
      return { ...current, [id]: { file, url, ready } };
    });
  }

  async function cutOut(id: ViewId, next: File) {
    const token = (cutoutToken.current[id] ?? 0) + 1;
    cutoutToken.current[id] = token;
    replaceView(id, next, false);
    setProcessing((current) => ({ ...current, [id]: true }));
    setFileError("");

    try {
      const isolated = await isolateGarment(next, `${id}-isolated.png`);
      if (cutoutToken.current[id] !== token) return;
      replaceView(id, isolated, true);
    } catch (err) {
      console.warn(`Auto background removal for ${id} skipped:`, err);
      try {
        const compressed = await compressImageForUpload(next);
        if (cutoutToken.current[id] !== token) return;
        replaceView(id, compressed, false);
      } catch {
        // Keep the original preview already on screen.
      }
    } finally {
      if (cutoutToken.current[id] === token) {
        setProcessing((current) => {
          const nextState = { ...current };
          delete nextState[id];
          return nextState;
        });
      }
    }
  }

  async function takeFile(id: ViewId, list: FileList | null) {
    const next = list?.[0];
    if (!next) return;
    if (!ACCEPT_RE.test(next.name)) {
      setFileError("Use a .jpg, .png, or .webp image.");
      return;
    }
    await cutOut(id, next);
  }

  async function generateRest() {
    if (generating) return;
    const ready = VIEWS.flatMap((view) => {
      const slot = views[view.id];
      return slot?.ready ? [{ id: view.id, file: slot.file }] : [];
    });
    if (ready.length === 0) return;

    const body = new FormData();
    for (const slot of ready) body.append(slot.id, slot.file);
    setGenerating(true);
    setFileError("");
    try {
      const response = await fetch("/api/upload-ai-design/generate", { method: "POST", body });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setFileError(typeof payload?.error === "string" ? payload.error : "Could not generate the other views.");
        return;
      }
      const images = payload?.images ?? {};
      const created = VIEWS.flatMap((view) => {
        const encoded = images[view.id];
        if (typeof encoded !== "string") return [];
        return [{ id: view.id, file: pngFile(view.id, encoded) }];
      });
      if (created.length === 0) {
        setFileError("Could not generate the other views.");
        return;
      }
      for (const slot of created) {
        cutoutToken.current[slot.id] = (cutoutToken.current[slot.id] ?? 0) + 1;
        replaceView(slot.id, slot.file, true);
      }
    } catch {
      setFileError("Could not generate the other views.");
    } finally {
      setGenerating(false);
    }
  }

  function removeView(id: ViewId) {
    cutoutToken.current[id] = (cutoutToken.current[id] ?? 0) + 1;
    setProcessing((current) => {
      const nextState = { ...current };
      delete nextState[id];
      return nextState;
    });
    setViews((current) => {
      const previous = current[id];
      if (previous) URL.revokeObjectURL(previous.url);
      return { ...current, [id]: null };
    });
  }

  const isRemovingBackground = Object.values(processing).some(Boolean);
  const hasReadyView = VIEWS.some((view) => views[view.id]?.ready);
  const fieldsLocked = !hasReadyView || isRemovingBackground || generating;
  const inputsLocked = isRemovingBackground || generating;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (fieldsLocked) return;
    if (!VIEWS.some((view) => views[view.id])) {
      setFileError("Add a front, back, left, or right image.");
      return;
    }
    setSubmitted(true);
  }

  const viewCount = VIEWS.filter((view) => views[view.id]).length;

  if (!open) {
    return (
      <main className="upload-ai-page">
        <button className="upload-ai-reopen" type="button" onClick={reopen}>
          Upload your AI design
        </button>
      </main>
    );
  }

  return (
    <main className="upload-ai-page">
      <div className="upload-ai-backdrop">
        <section className="upload-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-ai-title">
          <button className="upload-ai-close" type="button" aria-label="Close" onClick={() => setOpen(false)}>
            ×
          </button>

          <header className="upload-ai-head">
            <img className="upload-ai-logo" src="/upload-ai-design/header-mark.png" alt="" />
            <div>
              <h1 id="upload-ai-title">Upload your AI design</h1>
              <p>
                Drag and drop your AI generated design in the form below and get production-ready mockups for approval within 24hrs at <strong>NO charge</strong>.
              </p>
            </div>
          </header>

          {submitted ? (
            <p className="upload-ai-thanks" role="status">
              Received <strong>{filledLabels(views)}</strong>. Production-ready mockups are queued for approval within 24hrs.
            </p>
          ) : (
            <form onSubmit={onSubmit}>
              <div className="upload-ai-views">
                {generating ? (
                  <div className="upload-ai-dots" aria-hidden="true">
                    <div className="upload-ai-dots-field" />
                    <div className="upload-ai-dots-shine" />
                    <span className="upload-ai-dots-label">Creating images</span>
                  </div>
                ) : null}
                {VIEWS.map((view) => (
                  <ViewSlot
                    key={view.id}
                    id={view.id}
                    label={view.label}
                    file={views[view.id]}
                    active={dragOver === view.id}
                    onDragOver={() => setDragOver(view.id)}
                    onDragLeave={() => setDragOver((current) => (current === view.id ? null : current))}
                    onDrop={(files) => {
                      setDragOver(null);
                      takeFile(view.id, files);
                    }}
                    processing={Boolean(processing[view.id])}
                    disabled={inputsLocked}
                    onPick={(files) => takeFile(view.id, files)}
                    onRemove={() => removeView(view.id)}
                  />
                ))}
              </div>
              <p className="upload-ai-views-meta">
                <span>{viewCount} of 4 views</span>
                <span>JPG, PNG, or WEBP</span>
              </p>
              {(generating || (hasReadyView && !isRemovingBackground && viewCount < 4)) ? (
                <button type="button" className="upload-ai-generate" onClick={generateRest} disabled={generating || isRemovingBackground}>
                  {generating ? "Generating views" : "Generate the rest of the images with AI"}
                </button>
              ) : null}
              {fileError ? <p className="upload-ai-file-error">{fileError}</p> : null}

              <fieldset className="upload-ai-fields" disabled={fieldsLocked}>
              <label className="upload-ai-field">
                <span><i>*</i>Category:</span>
                <select
                  name="category"
                  required
                  value={category}
                  className={category ? undefined : "is-placeholder"}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  <option value="" disabled>
                    SELECT YOUR SPORT or CORPORATE APPAREL CATEGORY
                  </option>
                  {CATEGORIES.map((item) => (
                    <option key={item} value={item}>
                      {categoryLabel(item)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="upload-ai-field">
                <span><i>*</i>Name:</span>
                <input name="name" required autoComplete="name" placeholder="John Doe" />
              </label>

              <label className="upload-ai-field">
                <span><i>*</i>Email:</span>
                <input name="email" type="email" required autoComplete="email" placeholder="Emailname@domain.com" />
              </label>

              <label className="upload-ai-field">
                <span>Message:</span>
                <textarea
                  name="message"
                  rows={2}
                  placeholder="Add any additional details here. Ex: We'd like for the logo to be bigger than the design that we sent"
                />
              </label>

              <p className="upload-ai-required"><i>*</i>Required field</p>
              <button className="upload-ai-submit" type="submit">
                {isRemovingBackground ? "Removing background" : "Upload design"}
              </button>
              </fieldset>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}

const LENS = 280;
const LENS_MAG = 2.6;

function ViewSlot({
  id,
  label,
  file,
  active,
  onDragOver,
  onDragLeave,
  onDrop,
  processing,
  disabled,
  onPick,
  onRemove,
}: {
  id: ViewId;
  label: string;
  file: ViewFile | null;
  active: boolean;
  processing: boolean;
  disabled: boolean;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: (files: FileList) => void;
  onPick: (files: FileList | null) => void;
  onRemove: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [lens, setLens] = useState<{ left: number; top: number; width: number; height: number; posX: number; posY: number } | null>(null);

  function onMouseMove(event: MouseEvent<HTMLDivElement>) {
    const img = imgRef.current;
    if (!file || processing || !img) {
      setLens(null);
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;
    if (!naturalWidth || !naturalHeight) return;
    const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    const originX = (box.width - width) / 2;
    const originY = (box.height - height) / 2;
    const localX = event.clientX - box.left - originX;
    const localY = event.clientY - box.top - originY;
    if (localX < 0 || localY < 0 || localX > width || localY > height) {
      setLens(null);
      return;
    }
    const bgWidth = width * LENS_MAG;
    const bgHeight = height * LENS_MAG;
    let left = event.clientX + 18;
    let top = event.clientY - LENS / 2;
    if (left + LENS > window.innerWidth - 8) left = event.clientX - 18 - LENS;
    if (top < 8) top = 8;
    if (top + LENS > window.innerHeight - 8) top = window.innerHeight - LENS - 8;
    setLens({
      left,
      top,
      width: bgWidth,
      height: bgHeight,
      posX: LENS / 2 - (localX / width) * bgWidth,
      posY: LENS / 2 - (localY / height) * bgHeight,
    });
  }

  return (
    <div
      className={[
        "upload-ai-view",
        file ? "has-file" : "",
        active ? "is-over" : "",
      ].filter(Boolean).join(" ")}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(event.dataTransfer.files);
      }}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setLens(null)}
    >
      <label>
        <input
          aria-label={`${label} image`}
          type="file"
          accept={ACCEPT}
          disabled={processing || disabled}
          onChange={(event) => {
            onPick(event.target.files);
            event.target.value = "";
          }}
        />
        {file ? <img ref={imgRef} src={file.url} alt="" /> : <img className="upload-ai-glyph" src={`/upload-ai-design/${id}.png`} alt="" />}
        <span className="upload-ai-view-label">{label}</span>
        {file ? null : <span className="upload-ai-view-add">Add image</span>}
      </label>
      {file && !processing ? (
        <button type="button" className="upload-ai-view-remove" aria-label={`Remove ${label} image`} onClick={onRemove}>
          ×
        </button>
      ) : null}
      {lens && file ? (
        <span
          className="upload-ai-lens"
          aria-hidden="true"
          style={{
            left: lens.left,
            top: lens.top,
            backgroundImage: `url("${file.url}")`,
            backgroundSize: `${lens.width}px ${lens.height}px`,
            backgroundPosition: `${lens.posX}px ${lens.posY}px`,
          }}
        />
      ) : null}
      {processing ? (
        <div className="upload-ai-cutout" role="status" aria-label={`Removing background from ${label}`}>
          <span className="upload-ai-cutout-spinner" />
        </div>
      ) : null}
    </div>
  );
}

