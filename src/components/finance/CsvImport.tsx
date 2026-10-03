"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { Modal, Segmented, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { money } from "@/lib/format";
import {
  buildImportRows, detectColumns, detectDateOrder, normalizeMerchant, parseCsv,
  type DateOrder, type ImportPreviewRow,
} from "@/lib/finance-import";
import { ACCOUNT_TYPE_LABEL, type FinanceContext } from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { CategoryTile, TxAmount, errorText, shortDay, useDraftContext } from "./kit";

type Step = "pick" | "map" | "review" | "importing" | "done";
const MAX_BYTES = 5 * 1024 * 1024;
const CHUNK = 1000;

const DATE_ORDERS: { id: DateOrder; label: string }[] = [
  { id: "MDY", label: "Month/Day/Year" }, { id: "DMY", label: "Day/Month/Year" }, { id: "YMD", label: "Year-Month-Day" },
];

/** Guided CSV import: pick a file, check the columns, review, import, undo. */
export function CsvImport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bundle, currency, today, api } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const [step, setStep] = useState<Step>("pick");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [matched, setMatched] = useState(false);
  const [amountMode, setAmountMode] = useState<"single" | "split">("single");
  const [dateCol, setDateCol] = useState(0);
  const [descCol, setDescCol] = useState(-1);
  const [amountCol, setAmountCol] = useState(-1);
  const [debitCol, setDebitCol] = useState(-1);
  const [creditCol, setCreditCol] = useState(-1);
  const [categoryCol, setCategoryCol] = useState(-1);
  const [dateOrder, setDateOrder] = useState<DateOrder>("MDY");
  const [invertSigns, setInvertSigns] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [includeMaybe, setIncludeMaybe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState({ inserted: 0, skipped: 0, batches: [] as string[], uncategorized: 0 });
  const [drag, setDrag] = useState(false);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { draft.release(); return; }
    setStep("pick"); setFileName(""); setRows([]); setHeaderRow(0); setHeaders([]); setMatched(false);
    setAmountMode("single"); setDateCol(0); setDescCol(-1); setAmountCol(-1); setDebitCol(-1); setCreditCol(-1); setCategoryCol(-1);
    setDateOrder("MDY"); setInvertSigns(false); setIncludeMaybe(false); setError(null); setProgress("");
    setResult({ inserted: 0, skipped: 0, batches: [], uncategorized: 0 }); setDrag(false); setUndone(false); setBusy(false);
    const csv = bundle.accounts.filter((a) => a.source === "csv");
    setAccountId(csv.length === 1 ? csv[0].id : "");
    draft.capture();
    // Reset only when the dialog opens; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function readFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) { setRows([]); setFileName(""); return setError("That file is over 5 MB. Export a shorter date range."); }
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.length < 2) { setRows([]); setFileName(""); return setError("We couldn't find any rows in that file."); }
      const found = detectColumns(parsed);
      const m = found.mapping;
      setRows(parsed); setFileName(file.name); setHeaderRow(found.headerRow); setHeaders(found.headers);
      setDateCol(m?.date ?? 0);
      setDescCol(m?.description ?? -1);
      setAmountCol(m?.amount ?? -1);
      setDebitCol(m?.debit ?? -1);
      setCreditCol(m?.credit ?? -1);
      setCategoryCol(m?.category ?? -1);
      setAmountMode(m && m.amount === null ? "split" : "single");
      setMatched(Boolean(m && (m.amount !== null || m.debit !== null || m.credit !== null)));
      setDateOrder(detectDateOrder(parsed.slice(found.headerRow + 1, found.headerRow + 201).map((r) => r[m?.date ?? 0] ?? "")));
      setInvertSigns(false);
    } catch (e) {
      setRows([]); setFileName(""); setError(errorText(e));
    }
  }

  const mapping = useMemo(() => ({
    date: dateCol, description: descCol,
    amount: amountMode === "single" && amountCol >= 0 ? amountCol : null,
    debit: amountMode === "split" && debitCol >= 0 ? debitCol : null,
    credit: amountMode === "split" && creditCol >= 0 ? creditCol : null,
    category: categoryCol >= 0 ? categoryCol : null,
  }), [dateCol, descCol, amountMode, amountCol, debitCol, creditCol, categoryCol]);

  function mappingError(): string | null {
    const hasAmount = amountMode === "single" ? mapping.amount !== null : mapping.debit !== null || mapping.credit !== null;
    if (dateCol < 0 || !hasAmount) return "Pick the date and amount columns.";
    const used = [dateCol, descCol, mapping.amount, mapping.debit, mapping.credit, mapping.category].filter((x): x is number => x !== null && x >= 0);
    if (new Set(used).size !== used.length) return "Each column can only be used once.";
    return null;
  }
  const mapProblem = step === "map" ? mappingError() : null;

  const sample = useMemo(() => {
    if (step !== "map" || mapProblem || rows.length <= headerRow + 1) return null;
    try {
      return buildImportRows(rows.slice(0, headerRow + 2), { headerRow, mapping, dateOrder, invertSigns, accountId: accountId || null })[0] ?? null;
    } catch { return null; }
  }, [step, mapProblem, rows, headerRow, mapping, dateOrder, invertSigns, accountId]);

  const review = useMemo(() => {
    if (step !== "review" && step !== "importing") return null;
    const preview: ImportPreviewRow[] = buildImportRows(rows, { headerRow, mapping, dateOrder, invertSigns, accountId: accountId || null })
      .map((r) => (!r.error && r.date > today ? { ...r, error: "Date is in the future" } : r));
    const existing = new Set(bundle.transactions.map((t) => t.external_id).filter((x): x is string => Boolean(x)));
    const ledger = new Set(bundle.transactions.map((t) => `${t.date}|${t.amount_cents}|${t.kind}|${normalizeMerchant(t.description)}`));
    const errors = preview.filter((r) => r.error);
    const valid = preview.filter((r) => !r.error);
    const dupes = valid.filter((r) => existing.has(r.external_id));
    const rest = valid.filter((r) => !existing.has(r.external_id));
    const maybe = rest.filter((r) => ledger.has(`${r.date}|${r.amount_cents}|${r.kind}|${normalizeMerchant(r.description)}`));
    const maybeSet = new Set(maybe);
    const fresh = includeMaybe ? rest : rest.filter((r) => !maybeSet.has(r));
    const byName = new Map(bundle.categories.filter((c) => !c.archived).map((c) => [c.name.toLowerCase(), c.id]));
    const items = fresh.map((r) => ({ row: r, category_id: r.kind === "expense" && r.category_name ? byName.get(r.category_name.toLowerCase()) ?? null : null }));
    let inC = 0n, outC = 0n, transfers = 0;
    for (const r of fresh) {
      if (r.kind === "income") inC += BigInt(r.amount_cents);
      else if (r.kind === "expense") outC += BigInt(r.amount_cents);
      else transfers += 1;
    }
    return { errors, dupes: dupes.length, maybe: maybe.length, items, inC: Number(inC), outC: Number(outC), transfers };
  }, [step, rows, headerRow, mapping, dateOrder, invertSigns, accountId, includeMaybe, today, bundle.transactions, bundle.categories]);

  const catById = useMemo(() => new Map(bundle.categories.map((c) => [c.id, c])), [bundle.categories]);

  async function runImport() {
    if (!review) return;
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    const payload = review.items.map(({ row, category_id }) => ({
      date: row.date, description: row.description, amount_cents: row.amount_cents, kind: row.kind, category_id, external_id: row.external_id,
    }));
    if (!payload.length) return;
    const uncategorized = review.items.filter((x) => x.row.kind === "expense" && !x.category_id).length;
    setError(null); setStep("importing"); setBusy(true);
    let inserted = 0, skipped = 0, done = 0;
    const batches: string[] = [];
    try {
      for (let i = 0; i < payload.length; i += CHUNK) {
        const chunk = payload.slice(i, i + CHUNK);
        setProgress(`Importing ${Math.min(done + chunk.length, payload.length)} of ${payload.length}`);
        const r = await api.importTransactions(accountId || null, chunk, draft.captured);
        inserted += r.inserted; skipped += r.skipped; done += chunk.length;
        if (r.batch) batches.push(r.batch);
      }
      setResult({ inserted, skipped, batches, uncategorized });
      setStep("done");
    } catch (e) {
      if (!batches.length && inserted === 0) { setError(errorText(e)); setStep("review"); }
      else { setError(`Import stopped: ${errorText(e)}`); setResult({ inserted, skipped, batches, uncategorized }); setStep("done"); }
    } finally { setBusy(false); }
  }

  async function undoAll() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    setBusy(true); setError(null);
    try {
      let n = 0;
      for (const b of result.batches) n += await api.undoImport(b, draft.captured);
      setUndone(true);
      toast.ok(`Removed ${n} imported transactions`);
      onClose();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  function finish() {
    if (step === "done" && !undone && result.inserted > 0) {
      const ctx: FinanceContext | null = draft.captured ? { ...draft.captured } : null;
      const batches = result.batches;
      toast.ok(`Imported ${result.inserted} transactions`, batches.length && ctx ? {
        label: "Undo",
        run: () => {
          void (async () => {
            try {
              let n = 0;
              for (const b of batches) n += await api.undoImport(b, ctx);
              toast.ok(`Removed ${n} imported transactions`);
            } catch (e) { toast.err(e); }
          })();
        },
      } : undefined);
    }
    onClose();
  }

  const close = () => { if (!busy) finish(); };
  const stepNo = step === "pick" ? 1 : step === "map" ? 2 : 3;
  const title = step === "pick" ? "Import a CSV" : step === "map" ? "Check the columns" : step === "done" ? "Imported" : "Review";
  const colOptions = (none?: boolean) => (
    <>
      {none && <option value={-1}>None</option>}
      {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
    </>
  );
  const kindLabel = (k: string) => (k === "expense" ? "Spent" : k === "income" ? "Received" : "Transfer");
  const banner = error && <div className="banner neg" role="alert">{error}</div>;
  const staleBanner = draft.stale && <div className="banner neg">{STALE_DRAFT}</div>;

  let footer: React.ReactNode;
  if (step === "pick") footer = (<><button type="button" className="btn" onClick={close}>Cancel</button>
    <button type="button" className="btn btn-primary" disabled={!rows.length} onClick={() => { setError(null); setStep("map"); }}>Continue</button></>);
  else if (step === "map") footer = (<><button type="button" className="btn" onClick={() => { setError(null); setStep("pick"); }}>Back</button>
    <button type="button" className="btn btn-primary" onClick={() => { const p = mappingError(); if (p) return setError(p); setError(null); setStep("review"); }}>Preview</button></>);
  else if (step === "review" || step === "importing") {
    const n = review?.items.length ?? 0;
    footer = (<><button type="button" className="btn" disabled={busy} onClick={() => { setError(null); setStep("map"); }}>Back</button>
      <button type="button" className="btn btn-primary" disabled={busy || n === 0 || draft.stale} onClick={() => void runImport()}>
        {busy ? <><Spinner /> Importing</> : n === 0 ? "Nothing new to import" : `Import ${n} transactions`}</button></>);
  } else footer = (<>{result.batches.length > 0 && !undone && <button type="button" className="btn btn-ghost" disabled={busy || draft.stale} onClick={() => void undoAll()}>Undo import</button>}
    <button type="button" className="btn btn-primary" disabled={busy} onClick={finish}>Done</button></>);

  return (
    <Modal open={open} onClose={close} title={title} wide footer={footer}>
      <div className="stack">
        {step !== "done" && <div className="fin-act-steps">Step {stepNo} of 3</div>}
        {staleBanner}
        {banner}

        {step === "pick" && (
          <>
            <label className={`fin-upload${drag ? " drag" : ""}`} htmlFor="fin-csv-file"
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void readFile(e.dataTransfer.files[0]); }}>
              <FileUp aria-hidden />
              <div style={{ fontWeight: 600 }}>{fileName || "Drop a CSV here or choose a file"}</div>
              <div className="hint">{fileName ? `${rows.length - 1} rows found. Choose another file to replace it.` : "Export it from your bank's website. Most banks call it Download transactions."}</div>
              <input ref={fileRef} id="fin-csv-file" className="fin-act-input-hidden" type="file" accept=".csv,text/csv,.txt"
                onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <div className="field">
              <label className="label" htmlFor="fin-csv-account">Which account is this from?</label>
              <select id="fin-csv-account" className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">No account</option>
                {bundle.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {ACCOUNT_TYPE_LABEL[a.type]}</option>)}
              </select>
              <div className="hint">Picking the account lets us skip rows you already imported.</div>
            </div>
          </>
        )}

        {step === "map" && (
          <>
            {matched && <div className="hint pos">We matched the columns. Check the first row below.</div>}
            <div className="fin-act-map">
              <div className="field"><label className="label" htmlFor="csv-date">Date</label>
                <select id="csv-date" className="select" value={dateCol} onChange={(e) => setDateCol(Number(e.target.value))}>{colOptions()}</select></div>
              <div className="field"><label className="label" htmlFor="csv-desc">Description</label>
                <select id="csv-desc" className="select" value={descCol} onChange={(e) => setDescCol(Number(e.target.value))}>{colOptions(true)}</select></div>
            </div>
            <div role="group" aria-label="Amount format">
              <Segmented block value={amountMode} onChange={setAmountMode}
                options={[{ id: "single", label: "One amount column" }, { id: "split", label: "Separate in and out" }]} />
            </div>
            <div className="fin-act-map">
              {amountMode === "single" ? (
                <div className="field"><label className="label" htmlFor="csv-amount">Amount</label>
                  <select id="csv-amount" className="select" value={amountCol} onChange={(e) => setAmountCol(Number(e.target.value))}>{colOptions(true)}</select></div>
              ) : (
                <>
                  <div className="field"><label className="label" htmlFor="csv-debit">Money out</label>
                    <select id="csv-debit" className="select" value={debitCol} onChange={(e) => setDebitCol(Number(e.target.value))}>{colOptions(true)}</select></div>
                  <div className="field"><label className="label" htmlFor="csv-credit">Money in</label>
                    <select id="csv-credit" className="select" value={creditCol} onChange={(e) => setCreditCol(Number(e.target.value))}>{colOptions(true)}</select></div>
                </>
              )}
              <div className="field"><label className="label" htmlFor="csv-cat">Category (optional)</label>
                <select id="csv-cat" className="select" value={categoryCol} onChange={(e) => setCategoryCol(Number(e.target.value))}>{colOptions(true)}</select></div>
              <div className="field"><label className="label" htmlFor="csv-order">Date format</label>
                <select id="csv-order" className="select" value={dateOrder} onChange={(e) => setDateOrder(e.target.value as DateOrder)}>
                  {DATE_ORDERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></div>
            </div>
            <div>
              <label className="fin-act-check"><input type="checkbox" checked={invertSigns} onChange={(e) => setInvertSigns(e.target.checked)} />
                Purchases are positive numbers in this file</label>
              <div className="hint">Common for credit card exports.</div>
            </div>
            {sample && (sample.error
              ? <div className="hint fin-act-err">First row: {sample.error}</div>
              : <div className="hint">First row: {kindLabel(sample.kind)} {money(sample.amount_cents, currency)} · {sample.description} · {shortDay(sample.date)}</div>)}
          </>
        )}

        {(step === "review" || step === "importing") && review && (
          <>
            <div className="fin-act-counts">
              <span className="badge gold">{review.items.length} new</span>
              {review.dupes > 0 && <span className="badge">{review.dupes} already imported</span>}
              {review.maybe > 0 && <span className="badge">{review.maybe} possible duplicates</span>}
              {review.errors.length > 0 && <span className="badge">{review.errors.length} can&apos;t be read</span>}
            </div>
            {review.maybe > 0 && (
              <label className="fin-act-check"><input type="checkbox" checked={includeMaybe} onChange={(e) => setIncludeMaybe(e.target.checked)} />
                Import possible duplicates too</label>
            )}
            <div className="hint">In {money(review.inC, currency)} · Out {money(review.outC, currency)} · {review.transfers} transfers</div>
            {step === "importing" && <div className="hint" role="status">{progress}</div>}
            <div className="list fin-act-preview">
              {review.items.slice(0, 100).map(({ row, category_id }) => {
                const c = category_id ? catById.get(category_id) : null;
                return (
                  <div className="item" key={row.external_id + row.line}>
                    <CategoryTile category={c} income={row.kind === "income"} transfer={row.kind === "transfer"} size="sm" />
                    <div className="item-main">
                      <div className="item-title">{row.description}</div>
                      <div className="item-sub">{shortDay(row.date)} · {c?.name ?? (row.kind === "expense" ? "Uncategorized" : row.kind === "income" ? "Income" : "Transfer")}</div>
                    </div>
                    <div className="item-end"><div className="v"><TxAmount tx={row} currency={currency} /></div></div>
                  </div>
                );
              })}
            </div>
            {review.items.length > 100 && <div className="hint">And {review.items.length - 100} more</div>}
            {review.errors.length > 0 && (
              <details>
                <summary style={{ minHeight: 36, display: "flex", alignItems: "center", cursor: "pointer" }}>{review.errors.length} rows can&apos;t be read</summary>
                {review.errors.slice(0, 20).map((r) => <div key={r.line} className="hint fin-act-err">Line {r.line}: {r.error}</div>)}
              </details>
            )}
          </>
        )}

        {step === "done" && (
          <>
            <div className="serif" style={{ fontSize: 26, lineHeight: 1.15 }}>{undone ? "Import removed" : result.inserted > 0 ? `Imported ${result.inserted} transactions` : "Nothing new was added"}</div>
            {result.skipped > 0 && <div className="hint">{result.skipped} were already in your ledger.</div>}
            {result.uncategorized > 0 && result.inserted > 0 && <div className="hint">{result.uncategorized} expenses need a category. Filter by Uncategorized to sort them.</div>}
            {result.inserted >= 10 && <Link href="/finance/subscriptions" className="btn btn-sm" style={{ minHeight: 36, alignSelf: "flex-start" }} onClick={finish}>Check for subscriptions</Link>}
          </>
        )}
      </div>
    </Modal>
  );
}
