"use client";
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal, Segmented, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { SCORE_MAX, SCORE_MIN, SCORE_MODELS, sortScores, validateScore } from "@/lib/credit-scores";
import { BUREAU_LABEL, CREDIT_BUREAUS, type CreditBureau, type CreditScore } from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { errorText, useDraftContext } from "./kit";

export type CreditEditorMode = "one" | "all";
const OTHER = "__other";
const SOURCES = ["Credit Karma", "Experian app", "Bank app", "Card app", "myFICO", "Lender"];

/** Most recent model used for a bureau, so the next entry defaults to the same one. */
function lastModel(scores: readonly CreditScore[], bureau: CreditBureau): string {
  return sortScores(scores.filter((s) => s.bureau === bureau)).at(-1)?.model ?? "";
}
function lastSource(scores: readonly CreditScore[]): string {
  return sortScores(scores).at(-1)?.source ?? "";
}

function parseScore(text: string): number | null {
  const t = text.trim();
  if (!/^\d{3}$/.test(t)) return null;
  return Number(t);
}

/** Select of common models with an "Other" free-text escape hatch. */
function ModelPicker({ id, value, onChange, label = "Model" }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  const known = value === "" || (SCORE_MODELS as readonly string[]).includes(value);
  const [other, setOther] = useState(!known);
  useEffect(() => { if (!known) setOther(true); }, [known]);
  return (
    <div className="stack-sm">
      <select id={id} className="select" aria-label={label} value={other ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) { setOther(true); onChange(known ? "" : value); }
          else { setOther(false); onChange(e.target.value); }
        }}>
        <option value="">Not sure</option>
        {SCORE_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        <option value={OTHER}>Other</option>
      </select>
      {other && (
        <input className="input" aria-label={`${label} name`} maxLength={40} value={value} onChange={(e) => onChange(e.target.value)} placeholder="FICO Auto 8, Bankcard 8" />
      )}
    </div>
  );
}

type Row = { score: string; model: string };

/** Log or edit one credit score, or log all three bureaus for the same day. */
export function CreditScoreEditor({ open, score, bureau: startBureau, mode: startMode = "one", onClose }: {
  open: boolean; score: CreditScore | null; bureau?: CreditBureau | null; mode?: CreditEditorMode; onClose: () => void;
}) {
  const { bundle, today, api } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const scores = bundle.credit_scores;
  const editing = score !== null;

  const [mode, setMode] = useState<CreditEditorMode>("one");
  const [bureau, setBureau] = useState<CreditBureau>("experian");
  const [value, setValue] = useState("");
  const [model, setModel] = useState("");
  const [rows, setRows] = useState<Record<CreditBureau, Row>>({ equifax: { score: "", model: "" }, experian: { score: "", model: "" }, transunion: { score: "", model: "" } });
  const [date, setDate] = useState(today);
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Partial<Record<CreditBureau, string>>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) { draft.release(); return; }
    const b = score?.bureau ?? startBureau ?? "experian";
    setMode(score ? "one" : startMode);
    setBureau(b);
    setValue(score ? String(score.score) : "");
    setModel(score ? score.model : lastModel(scores, b));
    setRows(Object.fromEntries(CREDIT_BUREAUS.map((k) => [k, { score: "", model: lastModel(scores, k) }])) as Record<CreditBureau, Row>);
    setDate(score?.as_of ?? today);
    setSource(score ? score.source : lastSource(scores));
    setNote(score?.note ?? "");
    setError(null);
    setRowErrors({});
    setConfirmDelete(false);
    draft.capture();
    // Only reset when the dialog opens or switches entity; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, score?.id, startBureau, startMode]);

  useEffect(() => {
    if (confirmDelete) deleteRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [confirmDelete]);

  function pickBureau(b: CreditBureau) {
    setBureau(b);
    // Follow the bureau's usual model unless the user already picked one for this entry.
    if (!editing && (model === "" || model === lastModel(scores, bureau))) setModel(lastModel(scores, b));
  }

  async function saveOne() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    const n = parseScore(value);
    const invalid = n === null ? `Enter a score from ${SCORE_MIN} to ${SCORE_MAX}.` : validateScore({ score: n, as_of: date }, today);
    if (invalid || n === null) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      await api.saveCreditScore({ id: score?.id, bureau, score: n, model: model.trim(), as_of: date, source: source.trim(), note: note.trim() }, draft.captured);
      toast.ok(editing ? "Score saved" : `${BUREAU_LABEL[bureau]} score added`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveAll() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    const entries = CREDIT_BUREAUS.filter((b) => rows[b].score.trim() !== "");
    if (!entries.length) return setError("Enter at least one score.");
    const errs: Partial<Record<CreditBureau, string>> = {};
    for (const b of entries) {
      const n = parseScore(rows[b].score);
      const invalid = n === null ? `Enter a score from ${SCORE_MIN} to ${SCORE_MAX}.` : validateScore({ score: n, as_of: date }, today);
      if (invalid) errs[b] = invalid;
    }
    if (Object.keys(errs).length) { setRowErrors(errs); return setError(null); }
    setBusy(true);
    setError(null);
    setRowErrors({});
    const saved: CreditBureau[] = [];
    const failed: Partial<Record<CreditBureau, string>> = {};
    for (const b of entries) {
      try {
        await api.saveCreditScore({ bureau: b, score: parseScore(rows[b].score)!, model: rows[b].model.trim(), as_of: date, source: source.trim(), note: note.trim() }, draft.captured);
        saved.push(b);
      } catch (e) {
        failed[b] = errorText(e);
      }
    }
    setBusy(false);
    if (saved.length) {
      toast.ok(saved.length === 1 ? `${BUREAU_LABEL[saved[0]]} score added` : `${saved.length} scores added`);
      // Clear the rows that landed so a retry only resends the ones that failed.
      setRows((r) => ({ ...r, ...Object.fromEntries(saved.map((b) => [b, { ...r[b], score: "" }])) }));
    }
    if (Object.keys(failed).length) {
      setRowErrors(failed);
      setError(saved.length ? `Saved ${saved.map((b) => BUREAU_LABEL[b]).join(" and ")}. Fix the rest and try again.` : null);
      return;
    }
    onClose();
  }

  async function remove() {
    if (!score) return;
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    setBusy(true);
    setError(null);
    try {
      await api.deleteCreditScore(score.id, draft.captured);
      toast.ok("Score deleted");
      onClose();
    } catch (e) {
      setError(errorText(e));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  const title = editing ? "Edit score" : mode === "all" ? "Log all three" : "Add credit score";
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={title}
      footer={<>
        {editing && !confirmDelete && (
          <button type="button" className="btn btn-ghost btn-icon" style={{ marginRight: "auto" }} aria-label="Delete score" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 /></button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="fin-credit-form" className="btn btn-primary" disabled={busy || draft.stale}>
          {busy && <Spinner />}{editing ? "Save" : mode === "all" ? "Save scores" : "Add"}
        </button>
      </>}>
      <form id="fin-credit-form" className="stack" onSubmit={(e) => { e.preventDefault(); void (mode === "all" ? saveAll() : saveOne()); }}>
        {!editing && (
          <Segmented<CreditEditorMode> block value={mode} onChange={(m) => { setMode(m); setError(null); setRowErrors({}); }}
            options={[{ id: "one", label: "One bureau" }, { id: "all", label: "All three" }]} />
        )}

        {mode === "one" ? (
          <>
            <div className="field">
              <span className="label" id="fin-credit-bureau-label">Bureau</span>
              <div role="group" aria-labelledby="fin-credit-bureau-label">
                <Segmented<CreditBureau> block value={bureau} onChange={pickBureau}
                  options={CREDIT_BUREAUS.map((b) => ({ id: b, label: BUREAU_LABEL[b] }))} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label className="label" htmlFor="fin-credit-score">Score</label>
                <input id="fin-credit-score" className="input input-lg num fin-credit-input" inputMode="numeric" autoComplete="off" maxLength={3}
                  autoFocus={!editing} value={value} placeholder="720" onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} />
              </div>
              <div className="field">
                <label className="label" htmlFor="fin-credit-model">Model</label>
                <ModelPicker id="fin-credit-model" value={model} onChange={setModel} />
              </div>
            </div>
          </>
        ) : (
          <div className="fin-credit-rows">
            {CREDIT_BUREAUS.map((b) => (
              <div key={b} className="fin-credit-row">
                <label className="fin-credit-row-name" htmlFor={`fin-credit-${b}`}>{BUREAU_LABEL[b]}</label>
                <input id={`fin-credit-${b}`} className="input num fin-credit-input" inputMode="numeric" autoComplete="off" maxLength={3}
                  value={rows[b].score} placeholder="Skip" aria-invalid={rowErrors[b] ? true : undefined}
                  onChange={(e) => setRows((r) => ({ ...r, [b]: { ...r[b], score: e.target.value.replace(/\D/g, "") } }))} />
                <ModelPicker id={`fin-credit-${b}-model`} label={`${BUREAU_LABEL[b]} model`} value={rows[b].model}
                  onChange={(v) => setRows((r) => ({ ...r, [b]: { ...r[b], model: v } }))} />
                {rowErrors[b] && <div className="hint neg fin-credit-row-err" role="alert">{rowErrors[b]}</div>}
              </div>
            ))}
            <p className="hint">Leave a bureau blank to skip it.</p>
          </div>
        )}

        <div className="form-row">
          <div className="field">
            <label className="label" htmlFor="fin-credit-date">Score date</label>
            <input id="fin-credit-date" className="input" type="date" min="1900-01-01" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="fin-credit-source">Where you saw it</label>
            <input id="fin-credit-source" className="input" list="fin-credit-sources" maxLength={60} value={source} onChange={(e) => setSource(e.target.value)} placeholder="Credit Karma, bank app" />
            <datalist id="fin-credit-sources">{SOURCES.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="fin-credit-note">Note</label>
          <input id="fin-credit-note" className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Paid card to zero, new inquiry" />
        </div>

        {confirmDelete && score && (
          <div ref={deleteRef} className="banner neg" style={{ flexWrap: "wrap", justifyContent: "space-between" }}>
            <span style={{ flex: "1 1 180px", minWidth: 0 }}><b>Delete this {BUREAU_LABEL[score.bureau]} score?</b></span>
            <span className="row-flex" style={{ gap: 8 }}>
              <button type="button" className="btn btn-sm btn-ghost" style={{ minHeight: 36 }} onClick={() => setConfirmDelete(false)}>Keep it</button>
              <button type="button" className="btn btn-sm btn-danger" style={{ minHeight: 36 }} disabled={busy} onClick={() => void remove()}>{busy && <Spinner size={14} />}Delete</button>
            </span>
          </div>
        )}
        {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
        {error && <div className="banner neg" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
