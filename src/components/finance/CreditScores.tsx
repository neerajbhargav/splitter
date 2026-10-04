"use client";
import "@/components/finance/styles/credit.css";
import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, ListPlus, Minus, Plus } from "lucide-react";
import { Card } from "@/components/kit";
import { Segmented } from "@/components/ui";
import { creditOverview, scoreBand, scoreSeries, sortScores, summarizeBureaus, type BureauSummary } from "@/lib/credit-scores";
import { BUREAU_LABEL, type CreditBureau, type CreditScore } from "@/lib/finance-types";
import { useFinance } from "./FinanceProvider";
import { CreditScoreEditor, type CreditEditorMode } from "./CreditScoreEditor";
import { ScoreChart } from "./charts";
import { dayDiff } from "./kit";

const HISTORY_PREVIEW = 8;

function ago(date: string, today: string): string {
  const d = dayDiff(date, today);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 60) return `${d} days ago`;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.slice(0, 4) !== today.slice(0, 4)) opts.year = "numeric";
  return `${new Date(`${date}T00:00:00`).toLocaleDateString("en-US", opts)}`;
}
function fullDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function yearBefore(today: string): string {
  return `${String(Number(today.slice(0, 4)) - 1).padStart(4, "0")}${today.slice(4)}`;
}

type Editing = { score: CreditScore | null; bureau: CreditBureau | null; mode: CreditEditorMode };

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="fin-credit-change faint">First reading</span>;
  if (value === 0) return <span className="fin-credit-change faint"><Minus aria-hidden /> No change</span>;
  const up = value > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`fin-credit-change ${up ? "pos" : "neg"}`} aria-label={`${up ? "Up" : "Down"} ${Math.abs(value)} points`}>
      <Icon aria-hidden />{up ? "+" : "-"}{Math.abs(value)}
    </span>
  );
}

function BureauTile({ s, today, onAdd, onEdit }: { s: BureauSummary; today: string; onAdd: () => void; onEdit: (score: CreditScore) => void }) {
  const name = BUREAU_LABEL[s.bureau];
  if (!s.latest) {
    return (
      <div className="fin-credit-tile empty">
        <div className="fin-credit-name">{name}</div>
        <div className="fin-credit-none faint">No score yet</div>
        <button type="button" className="btn btn-sm" onClick={onAdd}><Plus /> Add score</button>
      </div>
    );
  }
  const band = scoreBand(s.latest.score, s.latest.model);
  return (
    <div className="fin-credit-tile">
      <button type="button" className="fin-credit-hit" onClick={() => onEdit(s.latest!)} aria-label={`Edit ${name} score ${s.latest.score}`} />
      <div className="fin-credit-top">
        <div className="fin-credit-name">{name}</div>
        <span className={`fin-status ${band.tone}`}>{band.label}</span>
      </div>
      <div className="fin-credit-big">{s.latest.score}</div>
      <Change value={s.change} />
      <div className="fin-credit-meta">
        {s.latest.model ? <div>{s.latest.model}</div> : null}
        <div>{ago(s.latest.as_of, today)}</div>
      </div>
      {s.stale && <button type="button" className="btn btn-sm fin-credit-update" onClick={onAdd}>Update</button>}
    </div>
  );
}

/** Equifax, Experian and TransUnion side by side, a trend line and the full history. */
export function CreditScores() {
  const { bundle, today } = useFinance();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [range, setRange] = useState<"year" | "all">("year");
  const [showAll, setShowAll] = useState(false);
  const scores = bundle.credit_scores;

  const view = useMemo(() => {
    const summaries = summarizeBureaus(scores, today);
    const overview = creditOverview(summaries);
    const history = sortScores(scores).reverse();
    const allSeries = scoreSeries(scores);
    const yearSeries = scoreSeries(scores, yearBefore(today));
    return { summaries, overview, history, allSeries, yearSeries };
  }, [scores, today]);
  const { summaries, overview, history, allSeries, yearSeries } = view;
  const series = range === "year" ? yearSeries : allSeries;
  const hasOlder = allSeries.length > yearSeries.length;

  const add = (bureau: CreditBureau | null, mode: CreditEditorMode = "one") => setEditing({ score: null, bureau, mode });
  const edit = (score: CreditScore) => setEditing({ score, bureau: score.bureau, mode: "one" });
  const shown = showAll ? history : history.slice(0, HISTORY_PREVIEW);

  return (
    <>
      <Card
        title="Credit scores"
        description={overview.reported ? `Latest from ${overview.reported === 3 ? "all three bureaus" : `${overview.reported} of 3 bureaus`}` : "Track Equifax, Experian and TransUnion in one place."}
        action={
          <div className="row-flex" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm" style={{ minHeight: 36 }} onClick={() => add(null, "all")}><ListPlus /> <span className="fin-credit-hide-sm">Log all three</span><span className="fin-credit-show-sm">All 3</span></button>
            <button type="button" className="btn btn-sm btn-primary" style={{ minHeight: 36 }} onClick={() => add(null)} aria-label="Add credit score"><Plus /> <span className="fin-credit-hide-sm">Add</span></button>
          </div>
        }
      >
        <div className="stack">
          <div className="fin-credit-grid">
            {summaries.map((s) => <BureauTile key={s.bureau} s={s} today={today} onAdd={() => add(s.bureau)} onEdit={edit} />)}
          </div>

          {overview.average !== null && (
            <div className="fin-credit-overview">
              <div className="row-flex wrap" style={{ gap: 6 }}>
                <span className="pill-stat">Average <b className="num">{overview.average}</b></span>
                {overview.spread !== null && <span className="pill-stat">Spread <b className="num">{overview.spread} pts</b></span>}
                {overview.lowest && overview.reported > 1 && <span className="pill-stat">Lowest <b>{BUREAU_LABEL[overview.lowest.bureau]}</b></span>}
              </div>
              {overview.insights.length > 0 && (
                <ul className="fin-credit-insights">
                  {overview.insights.map((t) => <li key={t}>{t}</li>)}
                </ul>
              )}
            </div>
          )}

          {allSeries.length >= 2 && (
            <div className="fin-credit-chart">
              <div className="between" style={{ marginBottom: 8, gap: 8 }}>
                <span className="label" style={{ margin: 0 }}>Trend</span>
                {hasOlder && (
                  <Segmented<"year" | "all"> value={range} onChange={setRange} options={[{ id: "year", label: "12 months" }, { id: "all", label: "All" }]} />
                )}
              </div>
              {series.length >= 2 ? <ScoreChart data={series} /> : <p className="hint">Only one reading in the last 12 months. Switch to All to see older ones.</p>}
            </div>
          )}

          {history.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 4 }}>History</div>
              <div className="list">
                {shown.map((h) => {
                  const band = scoreBand(h.score, h.model);
                  return (
                    <button key={h.id} type="button" className="item clickable" onClick={() => edit(h)}>
                      <span className={`icon-tile sm fin-credit-dot ${h.bureau}`} aria-hidden>{BUREAU_LABEL[h.bureau].slice(0, 2)}</span>
                      <div className="item-main">
                        <div className="item-title">{BUREAU_LABEL[h.bureau]}</div>
                        <div className="item-sub">{[fullDate(h.as_of), h.model, h.source].filter(Boolean).join(" · ")}</div>
                        {h.note && <div className="item-sub faint">{h.note}</div>}
                      </div>
                      <div className="item-end"><div className="v num">{h.score}</div><div className={`k fin-credit-band ${band.tone}`}>{band.label}</div></div>
                    </button>
                  );
                })}
              </div>
              {history.length > HISTORY_PREVIEW && (
                <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 8, minHeight: 36 }} onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Show less" : `Show all ${history.length}`}
                </button>
              )}
            </div>
          )}

          <p className="hint" style={{ margin: 0 }}>
            You can pull all three reports free every week at{" "}
            <a href="https://www.annualcreditreport.com" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>AnnualCreditReport.com</a>.
            Checking your own score never lowers it.
          </p>
        </div>
      </Card>
      <CreditScoreEditor open={editing !== null} score={editing?.score ?? null} bureau={editing?.bureau ?? null} mode={editing?.mode ?? "one"} onClose={() => setEditing(null)} />
    </>
  );
}
