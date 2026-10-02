"use client";
import { useEffect, useRef, useState } from "react";
import type { Worker } from "tesseract.js";
import { ScanLine } from "lucide-react";
import { centsToInput } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { parseReceipt, type ReceiptSuggestions } from "@/lib/receipt";

type Result = { description?: string; amount_cents?: number; date?: string };
type Props = { file: File | null; onApply: (result: Result) => void };

/** Images stay in this browser. OCR engine and English language assets download on demand. */
export function ReceiptScanner({ file, onApply }: Props) {
  const workerRef = useRef<Worker | null>(null);
  const runId = useRef(0);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ReceiptSuggestions | null>(null);
  const [raw, setRaw] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [applied, setApplied] = useState(false);

  function stop() {
    runId.current++;
    busyRef.current = false;
    const worker = workerRef.current;
    workerRef.current = null;
    if (worker) void worker.terminate().catch(() => {});
  }

  useEffect(() => {
    stop();
    setBusy(false);
    setStatus("");
    setProgress(0);
    setError(null);
    setSuggestions(null);
    setRaw("");
    setDescription("");
    setAmount("");
    setDate("");
    setApplied(false);
    return stop;
  }, [file]);

  const image = !!file && /\.(?:png|jpe?g|webp|bmp)$/i.test(file.name);
  const supported = image && (!file.type || /^(?:image\/(?:png|jpeg|webp|bmp|x-ms-bmp))$/i.test(file.type));

  async function scan() {
    if (!file || !supported || busyRef.current) return;
    if (file.size > 15 * 1024 * 1024) {
      setError("This image is too large to scan here. Use a receipt photo under 15 MB.");
      return;
    }
    busyRef.current = true;
    const id = ++runId.current;
    const active = () => runId.current === id;
    setBusy(true);
    setError(null);
    setSuggestions(null);
    setApplied(false);
    setProgress(0);
    setStatus("Loading English OCR engine");
    let worker: Worker | null = null;
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Lazy import keeps the OCR engine out of the normal editor bundle.
      const { createWorker } = await import("tesseract.js");
      if (!active()) return;
      const initializing = createWorker("eng", 1, {
        logger: (event) => {
          if (!active()) return;
          setStatus(event.status === "recognizing text" ? "Reading receipt" : "Loading OCR assets");
          setProgress(Math.max(0, Math.min(100, Math.round(event.progress * 100))));
        },
        errorHandler: () => {
          if (active()) setError("The OCR engine could not read this image. Cancel and retry with a clearer JPG or PNG.");
        },
      }).then((initialized) => {
        // createWorker has no abort signal. Terminate it as soon as initialization
        // finishes if this scan was canceled, unmounted or timed out meanwhile.
        if (abandoned || !active()) void initialized.terminate().catch(() => {});
        return initialized;
      });
      worker = await Promise.race([
        initializing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The OCR engine could not finish loading. Check your connection and retry.")), 60_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!active()) return;
      workerRef.current = worker;
      // Release browser memory if an image/worker gets stuck.
      const result = await Promise.race([
        worker.recognize(file),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Scanning took too long. Retry with a smaller, clearer receipt photo.")), 120_000);
        }),
      ]);
      if (!active()) return;
      const parsed = parseReceipt(result.data.text);
      setRaw(result.data.text);
      setSuggestions(parsed);
      setDescription(parsed.description ?? "");
      setAmount(parsed.amount_cents !== undefined ? centsToInput(parsed.amount_cents) : "");
      setDate(parsed.date ?? "");
      setProgress(100);
      setStatus("Ready to review");
    } catch (err) {
      if (active()) setError(err instanceof Error ? err.message : "Scanning failed. Retry with a clearer JPG or PNG.");
    } finally {
      abandoned = true;
      if (timer) clearTimeout(timer);
      if (workerRef.current === worker) workerRef.current = null;
      if (worker) void worker.terminate().catch(() => {});
      if (active()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function apply() {
    setError(null);
    const cents = amount.trim() ? parseMoney(amount) : undefined;
    if (cents !== undefined && (cents === null || cents <= 0 || !Number.isSafeInteger(cents))) {
      setError("Enter a valid positive total, or leave it blank to keep the current amount.");
      return;
    }
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + "T00:00:00Z")) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date)) {
      setError("Enter a valid receipt date, or leave it blank to keep the current date.");
      return;
    }
    const result: Result = {
      ...(description.trim() ? { description: description.trim().slice(0, 100) } : {}),
      ...(cents !== undefined && cents !== null ? { amount_cents: cents } : {}),
      ...(date ? { date } : {}),
    };
    if (!Object.keys(result).length) return setError("Add at least one reviewed value to apply.");
    onApply(result);
    setApplied(true);
  }

  if (!file) return null;
  if (!supported) return <p className="hint">Scan supports JPG, PNG, WebP and BMP photos. PDFs, HEIC and other files can be attached, but not scanned. English text only for now.</p>;

  return (
    <div className="stack-sm" style={{ marginTop: 10 }}>
      <div className="row-flex wrap">
        <button type="button" className="btn btn-sm" onClick={scan} disabled={busy}>
          <ScanLine /> {busy ? "Scanning..." : suggestions ? "Scan again" : error ? "Retry scan" : "Scan receipt"}
        </button>
        {busy && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { stop(); setBusy(false); setStatus("Scan canceled"); }}>Cancel scan</button>}
      </div>
      <p className="hint">English OCR runs on your device. Your receipt is not sent to an OCR service. Engine and language files download on first scan.</p>
      {busy && <div role="status" aria-live="polite">
        <span className="hint">{status} · {progress}%</span>
        <div className="progress sm" role="progressbar" aria-label="Receipt scanning progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>}
      {error && <div className="banner neg" role="alert">{error}</div>}
      {suggestions && !busy && <div className="card stack-sm" style={{ padding: 12 }}>
        <strong>Review scanned values</strong>
        <p className="hint">OCR can be wrong. Check these values against the receipt. Blank fields keep the current expense value. Confirm the amount uses your expense currency before applying.</p>
        {suggestions.warnings.length > 0 && <ul className="hint" style={{ paddingLeft: 18, margin: 0 }}>{suggestions.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        <div className="field">
          <label className="label" htmlFor="scan-desc">Merchant / description</label>
          <input id="scan-desc" className="input" maxLength={100} value={description} onChange={(e) => { setDescription(e.target.value); setApplied(false); }} />
        </div>
        <div className="field">
          <label className="label" htmlFor="scan-total">Receipt total</label>
          <input id="scan-total" className="input" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => { setAmount(e.target.value); setApplied(false); }} />
        </div>
        <div className="field">
          <label className="label" htmlFor="scan-date">Receipt date</label>
          <input id="scan-date" className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); setApplied(false); }} />
        </div>
        <details>
          <summary className="hint">Show recognized text</summary>
          <pre className="hint" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 180, overflow: "auto" }}>{raw || "No readable text found."}</pre>
        </details>
        <button type="button" className="btn btn-sm btn-primary" onClick={apply}>Apply reviewed values</button>
        {applied && <p className="hint" role="status">Applied to the editor. Review the expense and save when ready.</p>}
      </div>}
    </div>
  );
}
