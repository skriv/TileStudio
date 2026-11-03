import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Renders one PDF page to a PNG raster. Higher scale gives more precise tracing. */
export async function rasterizePdfPage(data: ArrayBuffer, pageNumber: number, scale = 3) {
  const task = getDocument({ data: new Uint8Array(data.slice(0)) });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(Math.min(Math.max(1, pageNumber), pdf.numPages));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D недоступен');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG export failed'))), 'image/png'));
    return { blob, width: canvas.width, height: canvas.height, pageCount: pdf.numPages };
  } finally {
    await task.destroy();
  }
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const r = { width: bmp.width, height: bmp.height };
  bmp.close();
  return r;
}
