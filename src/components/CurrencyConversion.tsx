"use client";
import { useEffect, useRef, useState } from "react";
import { CURRENCIES, centsToInput, money, todayISO } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { convertCents, getReferenceRate, parseRate, validateRateDate, type ConversionResult } from "@/lib/currency";

type Props = {
  currency: string; amountCents: number; date: string;
  initial?: { source_currency: string | null; source_amount_cents: number | null; fx_rate: number | null; fx_date: string | null };
  fixedSource?: string; sourceAmountCents?: number;
  onApply: (result: ConversionResult) => void; onClear: () => void;
};
export function CurrencyConversion({ currency, amountCents, date, initial, fixedSource, sourceAmountCents, onApply, onClear }: Props) {
  const [source, setSource] = useState(initial?.source_currency ?? (currency === "EUR" ? "USD" : "EUR"));
  const [amount, setAmount] = useState(initial?.source_amount_cents ? centsToInput(initial.source_amount_cents) : "");
  const [manual, setManual] = useState(false);
  const [rate, setRate] = useState(initial?.fx_rate ? String(initial.fx_rate) : "");
  const [rateDate, setRateDate] = useState(initial?.fx_date ?? (date > todayISO() ? todayISO() : date));
  const [provenance, setProvenance] = useState(initial?.fx_rate ? "Saved rate" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const [applied, setApplied] = useState<ConversionResult | null>(() => initial?.source_currency && initial.source_amount_cents && initial.fx_rate && initial.fx_date ? {
    amount_cents: amountCents, source_currency: initial.source_currency, source_amount_cents: initial.source_amount_cents, fx_rate: initial.fx_rate, fx_date: initial.fx_date,
  } : null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!initial?.source_currency || !initial.source_amount_cents || !initial.fx_rate || !initial.fx_date) { setApplied(null); return; }
    try { setApplied({amount_cents:convertCents(initial.source_amount_cents,initial.fx_rate),source_currency:initial.source_currency,source_amount_cents:initial.source_amount_cents,fx_rate:initial.fx_rate,fx_date:initial.fx_date}); } catch { setApplied(null); }
  }, [initial?.source_currency,initial?.source_amount_cents,initial?.fx_rate,initial?.fx_date]);
  useEffect(() => {
    request.current?.abort(); setBusy(false);
    if (!initial?.fx_rate) { setRate(""); setProvenance(""); setRateDate(date > todayISO() ? todayISO() : date); }
  }, [date, currency, initial?.fx_rate]);
  useEffect(()=>{if(fixedSource){request.current?.abort();setBusy(false);setSource(fixedSource);setRate(initial?.source_currency===fixedSource && initial.fx_rate ? String(initial.fx_rate) : "");setProvenance(initial?.source_currency===fixedSource && initial.fx_rate ? "Saved rate" : "");}},[fixedSource]);
  const sourceCents = sourceAmountCents ?? parseMoney(amount);
  const numericRate = parseRate(rate);
  let preview: number | null = null;
  let previewError: string | null = null;
  try { if (sourceCents && numericRate) preview = convertCents(sourceCents, numericRate); } catch (err) { previewError = err instanceof Error ? err.message : String(err); }
  const invalidate = () => { request.current?.abort(); setBusy(false); setRate(""); setProvenance(""); setError(null); };
  async function loadRate() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      const quote = await getReferenceRate(source, currency, date, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRate(String(quote.rate)); setRateDate(quote.date); setProvenance(source === currency ? "Same currency" : "ECB reference via Frankfurter");
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function apply() {
    try {
      if (source === currency) throw new Error("Choose a currency different from the group's currency.");
      if (sourceCents === null || sourceCents <= 0) throw new Error("Enter the amount paid in the original currency.");
      if (numericRate === null) throw new Error("Load a reference rate or enter a positive manual rate.");
      validateRateDate(rateDate);
      const result = { amount_cents: convertCents(sourceCents, numericRate), source_currency: source, source_amount_cents: sourceCents, fx_rate: numericRate, fx_date: rateDate };
      onApply(result); setApplied(result); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  return <details className="card" style={{ padding: 14 }} open={initial?.source_currency ? true : undefined}>
    <summary className="label" style={{ cursor: "pointer" }}>Convert from another currency</summary>
    <div className="stack" style={{ marginTop: 12, gap: 12 }}>
      <p className="hint">Your ledger stays in {currency}. {sourceAmountCents === undefined ? "Apply a conversion to fill the main amount; splits and payer amounts remain in " + currency + "." : "Your original total comes from the line items, tax and tip below. Apply a rate to convert the whole bill; payer amounts and final shares are in " + currency + "."}</p>
      <div className="form-row">
        <div className="field"><label className="label" htmlFor="fx-source">Original currency</label>
          <select id="fx-source" className="select" value={source} disabled={!!fixedSource} onChange={e => { invalidate(); setSource(e.target.value); }}>
            {Array.from(new Set([...CURRENCIES, source])).filter(c=>c!==currency).map(c => <option key={c} value={c}>{c}</option>)}
          </select></div>
        <div className="field"><label className="label" htmlFor="fx-amount">Original amount ({source})</label>
          <input id="fx-amount" className="input" inputMode="decimal" placeholder="0.00" value={sourceAmountCents === undefined ? amount : centsToInput(sourceAmountCents)} readOnly={sourceAmountCents !== undefined} onChange={e => setAmount(e.target.value)} /></div>
      </div>
      <label className="check"><input type="checkbox" checked={manual} onChange={e => { invalidate(); setManual(e.target.checked); setRateDate(date > todayISO() ? todayISO() : date); }} /> Enter my own rate</label>
      {manual ? <div className="form-row">
        <div className="field"><label className="label" htmlFor="fx-rate">1 {source} = how many {currency}?</label>
          <input id="fx-rate" className="input" inputMode="decimal" value={rate} placeholder="e.g. 1.14" onChange={e => { setRate(e.target.value); setProvenance("Manual rate"); }} /></div>
        <div className="field"><label className="label" htmlFor="fx-date">Rate date</label>
          <input id="fx-date" className="input" type="date" max={todayISO()} value={rateDate} onChange={e => setRateDate(e.target.value)} /></div>
      </div> : <div><button type="button" className="btn btn-sm" disabled={busy} onClick={loadRate}>{busy ? "Loading rate..." : "Get reference rate"}</button> <span className="hint">For {date}</span></div>}
      {numericRate && <div className="banner"><span>{provenance || "Rate"}: 1 {source} = {numericRate} {currency} · {rateDate}</span>
        {preview !== null && <p className="num" style={{ marginTop: 6 }}>{money(sourceCents ?? 0, source)} → {money(preview, currency)}</p>}
      </div>}
      <p className="hint">Reference rates do not include card fees or bank spreads. Weekends use the last available business-day rate. For the exact charge, use a manual rate. All inputs use two decimal places, including JPY.</p>
      <div className="row-flex wrap"><button type="button" className="btn btn-primary btn-sm" disabled={busy || preview === null} onClick={apply}>Apply conversion</button>
        {applied && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onClear(); setApplied(null); invalidate(); }}>Remove conversion details</button>}
      </div>
      {applied && <p className="hint">Applied: {money(applied.source_amount_cents, applied.source_currency)} at {applied.fx_rate} on {applied.fx_date}.
        {amountCents !== applied.amount_cents && <span className="neg"> Main amount has changed. Apply again to keep conversion details consistent.</span>}
      </p>}
      {(error || previewError) && <div className="banner neg" role="alert">{error || previewError}</div>}
    </div>
  </details>;
}
