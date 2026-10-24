"use client";

// 下絵（図面）の読み込み・保存。
// 図面の画像は大きいため共有データには入れず、この端末のブラウザ（IndexedDB）に保存する。
// 位置・大きさ・濃さ（UnderlaySetting）は配置データとして共有する。

const DB_NAME = "piping-underlay";
const STORE = "images";
const KEY = "current";

export type UnderlayImage = { name: string; dataUrl: string; width: number; height: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveUnderlayImage(img: UnderlayImage | null) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    if (img) tx.objectStore(STORE).put(img, KEY);
    else tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadUnderlayImage(): Promise<UnderlayImage | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as UnderlayImage) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** PDFの1ページ目を画像にする（長辺が約 maxPx ピクセル） */
export async function pdfToImage(data: ArrayBuffer, name: string, maxPx = 4200): Promise<UnderlayImage> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = maxPx / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return { name, dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

/** 画像ファイル（PNG・JPEGなど）を読み込む */
export function imageFileToUnderlay(file: File): Promise<UnderlayImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => resolve({ name: file.name, dataUrl, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error("画像を読み込めませんでした"));
      img.src = dataUrl;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
