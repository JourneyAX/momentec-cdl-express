"use client";

import { FormEvent, MouseEvent, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { compressImageForUpload, isolateGarment, preloadBackgroundRemoval } from "@/lib/client-image";
import "./upload-ai-design.css";

const UploadAiModel = dynamic(() => import("./UploadAiModel").then((mod) => mod.UploadAiModel), { ssr: false });

const ACCEPT = ".jpg,.jpeg,.png,.webp";
const ACCEPT_RE = /\.(jpe?g|png|webp)$/i;

const VIEWS = [
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
] as const;

const MAX_REFERENCES = 8;

type ViewId = (typeof VIEWS)[number]["id"];
type ViewFile = { file: File; url: string; ready: boolean };
type ViewMap = Record<ViewId, ViewFile | null>;
type Reference = { id: string; file: File; url: string; ready: boolean; source: File };

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

export function UploadAiDesignModal() {
  const [open, setOpen] = useState(true);
  const [references, setReferences] = useState<Reference[]>([]);
  const [views, setViews] = useState<ViewMap>(EMPTY_VIEWS);
  const [fileError, setFileError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState<Record<string, boolean>>({});
  const [generating, setGenerating] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [category, setCategory] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [showingModel, setShowingModel] = useState(false);
  const [makingModel, setMakingModel] = useState(false);
  const referencesRef = useRef(references);
  const viewsRef = useRef(views);
  const cutoutToken = useRef<Record<string, number>>({});
  const modelToken = useRef(0);
  const modelUrlRef = useRef<string | null>(null);
  referencesRef.current = references;
  viewsRef.current = views;

  useEffect(() => {
    return () => {
      for (const reference of referencesRef.current) URL.revokeObjectURL(reference.url);
      for (const view of Object.values(viewsRef.current)) {
        if (view) URL.revokeObjectURL(view.url);
      }
      if (modelUrlRef.current) URL.revokeObjectURL(modelUrlRef.current);
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

  function clearDesign() {
    for (const reference of referencesRef.current) URL.revokeObjectURL(reference.url);
    for (const view of Object.values(viewsRef.current)) {
      if (view) URL.revokeObjectURL(view.url);
    }
    setReferences([]);
    setViews(EMPTY_VIEWS);
    clearModel();
  }

  function clearModel() {
    modelToken.current += 1;
    if (modelUrlRef.current) URL.revokeObjectURL(modelUrlRef.current);
    modelUrlRef.current = null;
    setModelUrl(null);
    setModelFile(null);
    setShowingModel(false);
    setMakingModel(false);
  }

  function reopen() {
    setSubmitted(false);
    clearDesign();
    setFileError("");
    setEditNote("");
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

  function placeReference(id: string, file: File, ready: boolean) {
    const url = URL.createObjectURL(file);
    setReferences((current) => {
      const previous = current.find((item) => item.id === id);
      if (previous) URL.revokeObjectURL(previous.url);
      const next = { id, file, url, ready, source: previous?.source ?? file };
      if (!previous) return [...current, next];
      return current.map((item) => (item.id === id ? next : item));
    });
  }

  async function cutOut(id: string, next: File) {
    const token = (cutoutToken.current[id] ?? 0) + 1;
    cutoutToken.current[id] = token;
    placeReference(id, next, false);
    setProcessing((current) => ({ ...current, [id]: true }));
    setFileError("");

    try {
      const isolated = await isolateGarment(next, `${id}-isolated.png`);
      if (cutoutToken.current[id] !== token) return;
      placeReference(id, isolated, true);
    } catch (err) {
      console.warn("Auto background removal skipped:", err);
      try {
        const compressed = await compressImageForUpload(next);
        if (cutoutToken.current[id] !== token) return;
        placeReference(id, compressed, false);
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

  function takeFiles(list: FileList | null) {
    const incoming = Array.from(list ?? []);
    if (incoming.length === 0) return;
    if (incoming.some((file) => !ACCEPT_RE.test(file.name))) {
      setFileError("Use a .jpg, .png, or .webp image.");
      return;
    }
    const room = MAX_REFERENCES - referencesRef.current.length;
    if (room <= 0) {
      setFileError("You can add up to 8 images.");
      return;
    }
    const accepted = incoming.slice(0, room);
    if (accepted.length < incoming.length) setFileError("You can add up to 8 images.");
    for (const file of accepted) void cutOut(crypto.randomUUID(), file);
  }

  async function requestSheet(files: File[], instruction = "") {
    if (generating || files.length === 0) return;

    const body = new FormData();
    for (const file of files) body.append("reference", file);
    if (instruction) body.append("instruction", instruction);
    clearModel();
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

  function generateRest() {
    const ready = references.filter((item) => item.ready).map((item) => item.file);
    void requestSheet(ready);
  }

  function applyEdit() {
    const note = editNote.trim();
    if (!note) {
      setFileError("Tell us what to change.");
      return;
    }
    const files = VIEWS.flatMap((view) => {
      const slot = views[view.id];
      return slot?.ready ? [slot.file] : [];
    });
    void requestSheet(files, note);
  }

  function removeReference(id: string) {
    cutoutToken.current[id] = (cutoutToken.current[id] ?? 0) + 1;
    setProcessing((current) => {
      const nextState = { ...current };
      delete nextState[id];
      return nextState;
    });
    setReferences((current) => {
      const previous = current.find((item) => item.id === id);
      if (previous) URL.revokeObjectURL(previous.url);
      return current.filter((item) => item.id !== id);
    });
    for (const view of Object.values(viewsRef.current)) {
      if (view) URL.revokeObjectURL(view.url);
    }
    setViews(EMPTY_VIEWS);
    setEditNote("");
    clearModel();
  }

  async function viewIn3d() {
    if (modelUrl) {
      setShowingModel(true);
      return;
    }
    const body = new FormData();
    for (const view of VIEWS) {
      const file = views[view.id]?.file;
      if (file) body.append(view.id, file);
    }
    const token = modelToken.current;
    setMakingModel(true);
    setFileError("");
    try {
      const response = await fetch("/api/upload-ai-design/model", { method: "POST", body });
      if (modelToken.current !== token) return;
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setFileError(typeof payload?.error === "string" ? payload.error : "Could not make the 3D view.");
        return;
      }
      const blob = await response.blob();
      if (modelToken.current !== token) return;
      const file = new File([blob], "model.glb", { type: "model/gltf-binary" });
      const url = URL.createObjectURL(file);
      modelUrlRef.current = url;
      setModelFile(file);
      setModelUrl(url);
      setShowingModel(true);
    } catch {
      if (modelToken.current === token) setFileError("Could not make the 3D view.");
    } finally {
      if (modelToken.current === token) setMakingModel(false);
    }
  }

  const isRemovingBackground = Object.values(processing).some(Boolean);
  const hasReadyReference = references.some((item) => item.ready);
  const inputsLocked = isRemovingBackground || generating || preparing || submitted;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (fieldsLocked || preparing) return;
    if (!VIEWS.every((view) => views[view.id]?.ready)) {
      setFileError("Make the four views before uploading the design.");
      return;
    }
    const body = new FormData(event.currentTarget);
    for (const view of VIEWS) {
      const file = views[view.id]?.file;
      if (file) body.append(view.id, file);
    }
    for (const item of referencesRef.current) body.append("upload", item.source);
    if (modelFile) body.append("model", modelFile);
    setPreparing(true);
    setFileError("");
    try {
      const response = await fetch("/api/upload-ai-design/submit", { method: "POST", body });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setFileError(typeof payload?.error === "string" ? payload.error : "Could not send the design.");
        return;
      }
      setSubmitted(true);
    } catch {
      setFileError("Could not prepare the art files.");
    } finally {
      setPreparing(false);
    }
  }

  const viewCount = VIEWS.filter((view) => views[view.id]).length;
  const fieldsLocked = viewCount < 4 || isRemovingBackground || generating || preparing || submitted;
  const referenceLabel = references.length === 1 ? "1 image" : `${references.length} images`;

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

            <form onSubmit={onSubmit}>
              <div
                className={["upload-ai-drop", dragOver ? "is-over" : ""].filter(Boolean).join(" ")}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!inputsLocked) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  if (!inputsLocked) takeFiles(event.dataTransfer.files);
                }}
              >
                <label className="upload-ai-drop-label">
                  <input
                    aria-label="Design images"
                    type="file"
                    accept={ACCEPT}
                    multiple
                    disabled={inputsLocked}
                    onChange={(event) => {
                      takeFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <span className="upload-ai-drop-title">Drop your idea here</span>
                  <span className="upload-ai-drop-hint">One photo is enough. We'll turn it into front, back, left, and right.</span>
                  <span className="upload-ai-drop-browse">Browse</span>
                </label>
                {references.length > 0 ? (
                  <div className="upload-ai-refs">
                    {references.map((item, index) => (
                      <div className="upload-ai-ref" key={item.id}>
                        <img src={item.url} alt={`Design image ${index + 1}`} />
                        {processing[item.id] ? (
                          <div className="upload-ai-cutout" role="status" aria-label="Removing background">
                            <span className="upload-ai-cutout-spinner" />
                          </div>
                        ) : (
                          <button type="button" className="upload-ai-view-remove" aria-label={`Remove design image ${index + 1}`} onClick={() => removeReference(item.id)}>
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <p className="upload-ai-views-meta">
                <span>{references.length === 0 ? "" : referenceLabel}</span>
                <span>JPG, PNG, or WEBP</span>
              </p>
              {viewCount === 4 && !generating ? (
                <div className="upload-ai-3d-bar">
                  {showingModel ? (
                    <button type="button" className="upload-ai-3d" onClick={() => setShowingModel(false)}>
                      Back to 4 views
                    </button>
                  ) : (
                    <button type="button" className="upload-ai-3d" onClick={viewIn3d} disabled={makingModel || preparing}>
                      {makingModel ? "Making the 3D view" : "View in 3D"}
                      <span className="upload-ai-beta">Beta</span>
                    </button>
                  )}
                </div>
              ) : null}
              {(generating || viewCount > 0) ? (
                showingModel && modelUrl ? (
                  <UploadAiModel url={modelUrl} />
                ) : (
                <div className="upload-ai-views">
                  {generating || makingModel ? (
                    <div className="upload-ai-dots" aria-hidden="true">
                      <div className="upload-ai-dots-field" />
                      <div className="upload-ai-dots-shine" />
                      <span className="upload-ai-dots-label">{makingModel ? "Making the 3D view" : "Creating images"}</span>
                    </div>
                  ) : null}
                  {VIEWS.map((view) => (
                    <ViewSlot key={view.id} id={view.id} label={view.label} file={views[view.id]} zoom={!(generating || makingModel)} />
                  ))}
                </div>
                )
              ) : null}
              {viewCount === 4 && !showingModel ? (
                <div className="upload-ai-edit">
                  <label>
                    <span>Change the look</span>
                    <textarea
                      rows={2}
                      value={editNote}
                      disabled={generating || makingModel}
                      placeholder="Brighter colors, thicker stripes, a cleaner collar"
                      onChange={(event) => setEditNote(event.target.value)}
                    />
                  </label>
                  <button type="button" className="upload-ai-generate" onClick={applyEdit} disabled={generating || makingModel || preparing || editNote.trim().length === 0}>
                    {generating ? "Making the views" : "Apply this edit"}
                  </button>
                </div>
              ) : null}
              {viewCount < 4 && (generating || (hasReadyReference && !isRemovingBackground)) ? (
                <button type="button" className="upload-ai-generate" onClick={generateRest} disabled={generating || preparing || isRemovingBackground}>
                  {generating ? "Making the views" : "Make the four views"}
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
              <button className={submitted ? "upload-ai-submit is-done" : "upload-ai-submit"} type="submit" disabled={preparing || submitted}>
                {submitted ? (
                  <>
                    <span className="upload-ai-tick" aria-hidden="true">✓</span>
                    Design uploaded successfully
                  </>
                ) : preparing ? (
                  "Sending"
                ) : isRemovingBackground ? (
                  "Removing background"
                ) : (
                  "Upload design"
                )}
              </button>
              </fieldset>
            </form>
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
  zoom,
}: {
  id: ViewId;
  label: string;
  file: ViewFile | null;
  zoom: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [lens, setLens] = useState<{ left: number; top: number; width: number; height: number; posX: number; posY: number } | null>(null);

  useEffect(() => {
    if (!zoom) setLens(null);
  }, [zoom]);

  function onMouseMove(event: MouseEvent<HTMLDivElement>) {
    const img = imgRef.current;
    if (!zoom || !file || !img) {
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
      className={["upload-ai-view", "is-result", file ? "has-file" : ""].filter(Boolean).join(" ")}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setLens(null)}
    >
      <div>
        {file ? <img ref={imgRef} src={file.url} alt="" /> : <img className="upload-ai-glyph" src={`/upload-ai-design/${id}.png`} alt="" />}
        <span className="upload-ai-view-label">{label}</span>
      </div>
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
    </div>
  );
}

