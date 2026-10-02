/** Browser-local PDF receipt processing. No URL/file upload is used by PDF.js. */
export const RECEIPT_PDF_MAX_PAGES = 5;
export const RECEIPT_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
export const RECEIPT_PDF_MAX_PIXELS = 4_000_000;
export const RECEIPT_PDF_MAX_DIMENSION = 2400;

export type PdfTextToken = { str?: string; transform?: number[]; height?: number; hasEOL?: boolean };
type Viewport = { width: number; height: number };
export type ReceiptPdfPage = {
  getTextContent(): Promise<{ items: PdfTextToken[] }>;
  getViewport(options: { scale: number }): Viewport;
  render(options: { canvas: HTMLCanvasElement; viewport: Viewport; background: string }): { promise: Promise<unknown>; cancel(): void };
  cleanup(): unknown;
};
export type ReceiptPdfApi = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: Record<string, unknown>): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<ReceiptPdfPage> }>;
    destroy(): Promise<void>;
  };
};
export type ReceiptPdfResult = { text: string; warnings: string[]; pagesRead: number; totalPages: number; complete: boolean };
type Options = {
  signal: AbortSignal;
  recognize: (canvas: HTMLCanvasElement) => Promise<string>;
  onProgress?: (status: string, progress: number) => void;
  /** Test seams: production always uses the lazy PDF.js module and a DOM canvas. */
  loadPdf?: () => Promise<ReceiptPdfApi>;
  makeCanvas?: () => HTMLCanvasElement;
};

export function pdfTextToLines(items: PdfTextToken[]): string {
  const tokens = items.filter((it) => typeof it.str === "string" && it.str.trim());
  // Some PDFs have no geometric text positions. Keep explicit end-of-line hints.
  if (!tokens.every(it => it.transform && Number.isFinite(it.transform[4]) && Number.isFinite(it.transform[5]))) {
    return tokens.map(it => it.str + (it.hasEOL ? "\n" : " ")).join("").trim();
  }
  const rows: { y: number; tokens: PdfTextToken[] }[] = [];
  for (const it of tokens) {
    const y = it.transform![5];
    const row = rows.find(r => Math.abs(r.y - y) <= 2.5);
    if (row) row.tokens.push(it); else rows.push({ y, tokens: [it] });
  }
  return rows.sort((a, b) => b.y - a.y).map(row => row.tokens.sort((a, b) => a.transform![4] - b.transform![4]).map(it => it.str).join(" ")).join("\n");
}

/** Native headers alone are not enough: mixed image/text PDFs need OCR too. */
export function usablePdfReceiptText(text: string): boolean {
  return (text.match(/[A-Za-z]/g)?.length ?? 0) >= 12 && /\b(?:grand\s+total|total|amount\s+due|balance\s+due)\b/i.test(text);
}

export function receiptPdfScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("The PDF page has invalid dimensions.");
  // At most ~16 MB of RGBA canvas, one page at a time, even for giant pages.
  return Math.min(2, RECEIPT_PDF_MAX_DIMENSION / Math.max(width, height), Math.sqrt(RECEIPT_PDF_MAX_PIXELS / (width * height)));
}

function canceled(): Error { return new DOMException("Receipt scan canceled", "AbortError"); }
export function pdfReceiptError(error: unknown): Error {
  const e = error as { name?: string; message?: string };
  if (e?.name === "AbortError") return error as Error;
  if (e?.name === "PasswordException" || /password|encrypted/i.test(e?.message ?? "")) return new Error("This PDF is password-protected. Attach an unlocked copy to scan it; no password is requested or stored.");
  if (e?.name === "InvalidPDFException" || /invalid pdf|pdf structure/i.test(e?.message ?? "")) return new Error("This file could not be read as a PDF. Try another PDF or a receipt photo.");
  return new Error(e?.message || "The PDF could not be scanned. Try a receipt photo instead.");
}

export async function readReceiptPdf(file: Blob, options: Options): Promise<ReceiptPdfResult> {
  if (file.size > RECEIPT_DOCUMENT_MAX_BYTES) throw new Error("This PDF is too large to scan here. Use a file under 15 MB.");
  let expired = false;
  const check = () => { if (options.signal.aborted) throw canceled(); if (expired) throw new Error("The PDF scan took too long. Try a smaller PDF or a receipt photo."); };
  check();
  const pdf = await (options.loadPdf?.() ?? import("pdfjs-dist").then(m => m as unknown as ReceiptPdfApi));
  check();
  pdf.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const bytes = new Uint8Array(await file.arrayBuffer());
  check();
  const loading = pdf.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, disableAutoFetch: true, disableRange: true, disableStream: true });
  let render: ReturnType<ReceiptPdfPage["render"]> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let destroying: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const destroy = () => { if (!destroying) destroying = loading.destroy().catch(() => {}); return destroying; };
  const releaseCanvas = () => { if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; } };
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => { render?.cancel(); void destroy(); if (options.signal.aborted) rejectAbort(canceled()); };
  options.signal.addEventListener("abort", cancel, { once: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; cancel(); reject(new Error("The PDF scan took too long. Try a smaller PDF or a receipt photo.")); }, 180_000);
  });
  try {
    const processing = async (): Promise<ReceiptPdfResult> => {
      options.onProgress?.("Opening PDF locally", 0);
      const document = await loading.promise;
      check();
      const count = Math.min(document.numPages, RECEIPT_PDF_MAX_PAGES);
      if (count < 1) throw new Error("This PDF has no readable pages.");
      const warnings: string[] = [];
      if (document.numPages > count) warnings.push(`Only the first ${count} of ${document.numPages} PDF pages were scanned. The final total may be on a later page; enter it yourself or upload a shorter receipt PDF.`);
      const chunks: string[] = [];
      for (let n = 1; n <= count; n++) {
        check();
        options.onProgress?.(`Reading PDF text, page ${n} of ${count}`, Math.floor((n - 1) / count * 100));
        const page = await document.getPage(n);
        check();
        try {
          const native = pdfTextToLines((await page.getTextContent()).items);
          check();
          let text = native;
          if (!usablePdfReceiptText(native)) {
            options.onProgress?.(`Rendering PDF page ${n} of ${count} for local OCR`, Math.floor((n - 1) / count * 100));
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: receiptPdfScale(base.width, base.height) });
            canvas = options.makeCanvas?.() ?? documentCanvas();
            // Floor prevents ceil rounding from exceeding the explicit pixel budget.
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            render = page.render({ canvas, viewport, background: "rgb(255,255,255)" });
            await render.promise;
            render = null;
            check();
            options.onProgress?.(`Reading PDF page ${n} of ${count} with local OCR`, Math.floor((n - 1) / count * 100));
            const ocr = await options.recognize(canvas);
            check();
            // Preserve native evidence, including conflicting totals, rather than replacing it.
            text = [native, ocr].filter(Boolean).join("\n");
          }
          chunks.push(text);
        } finally {
          render?.cancel(); render = null;
          if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
          page.cleanup();
        }
      }
      options.onProgress?.("Ready to review", 100);
      return { text: chunks.join("\n\n"), warnings, pagesRead: count, totalPages: document.numPages, complete: count === document.numPages };
    };
    return await Promise.race([processing(), deadline, aborted]);
  } catch (error) {
    if (options.signal.aborted) throw canceled();
    throw pdfReceiptError(error);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    cancel();
    releaseCanvas();
    await destroy();
  }
}
function documentCanvas(): HTMLCanvasElement { return document.createElement("canvas"); }
