"use client";
import { useState } from "react";
// shadcn/ui-style chart building blocks on Recharts.
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { money, moneyShort } from "@/lib/format";

export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];

type TipRow = { name: string; value: number; color?: string };

function Tip({ title, rows, currency }: { title?: string; rows: TipRow[]; currency: string }) {
  return (
    <div className="chart-tip">
      {title && <div className="t">{title}</div>}
      {rows.map((r) => (
        <div className="r" key={r.name}>
          <span>{r.color && <i className="sw" style={{ background: r.color }} />}{r.name}</span>
          <b className="num">{money(r.value, currency)}</b>
        </div>
      ))}
    </div>
  );
}

export type Slice = { key: string; name: string; value: number; color: string };

/** Donut with a big number in the middle and a legend beside it.
 *  Hovering/tapping a slice (or legend row) swaps the center text to that slice,
 *  so there is no floating tooltip to collide with the center label. */
export function Donut({ data, currency, center, centerLabel, height = 180 }: {
  data: Slice[]; currency: string; center: string; centerLabel: string; height?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const total = data.reduce((a, d) => a + d.value, 0);
  const shown = total > 0 ? data : [{ key: "none", name: "Nothing yet", value: 1, color: "var(--surface-3)" }];
  const hot = active !== null && total > 0 ? data[active] : null;
  return (
    <div className="donut-wrap">
      <div className="donut-grid" onMouseLeave={() => setActive(null)}>
        <div className="donut-box" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={shown} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="100%" paddingAngle={total > 0 && data.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}
                onMouseEnter={(_, i) => total > 0 && setActive(i)} onClick={(_, i) => total > 0 && setActive((a) => (a === i ? null : i))}>
                {shown.map((d, i) => <Cell key={d.key} fill={d.color} fillOpacity={active === null || active === i ? 1 : 0.35} style={{ outline: "none", cursor: total > 0 ? "pointer" : "default" }} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="donut-center">
            {(() => { const txt = hot ? money(hot.value, currency) : center; return (
              <div className="donut-num" style={{ fontSize: Math.min(26, Math.floor((height * 0.68 * 2) / Math.max(4, txt.length))) }}>{txt}</div>
            ); })()}
            <div className="tiny faint donut-sub">{hot ? `${hot.name} · ${Math.round((hot.value / total) * 100)}%` : centerLabel}</div>
          </div>
        </div>
        <div className="legend">
          {data.length ? data.slice(0, 6).map((d, i) => (
            <div className={`legend-row ${active === i ? "on" : ""}`} key={d.key} onMouseEnter={() => setActive(i)}>
              <i className="sw" style={{ background: d.color }} />
              <span className="nm" title={d.name}>{d.name}</span>
              <span className="v">{money(d.value, currency)}</span>
            </div>
          )) : <span className="hint">Nothing to show yet.</span>}
          {data.length > 6 && <span className="tiny faint">+{data.length - 6} more</span>}
        </div>
      </div>
    </div>
  );
}

/** Monthly spending: one bar per month for the group total, your share filling it from
 *  the bottom, amounts printed on the bars. Hover or tap a month to read it in the header
 *  (no floating tooltip). The latest month is selected by default. */
export function MonthlyBars({ data, currency, height = 210 }: {
  data: { label: string; total: number; mine: number }[]; currency: string; height?: number;
}) {
  const last = data.length - 1;
  const [active, setActive] = useState<number | null>(null);
  const i = active ?? last;
  const cur = data[i];
  const max = Math.max(1, ...data.map((d) => d.total));
  const empty = data.every((d) => d.total === 0);
  return (
    <div className="mbars">
      <div className="mbars-read" aria-live="polite">
        <span className="mbars-month">{cur?.label ?? ""}</span>
        <span><i className="sw ghost" /> Group <b className="num">{money(cur?.total ?? 0, currency)}</b></span>
        <span><i className="sw gold" /> Your share <b className="num">{money(cur?.mine ?? 0, currency)}</b></span>
      </div>
      <div className="mbars-plot" style={{ height }} onMouseLeave={() => setActive(null)} role="list">
        {data.map((d, k) => {
          const h = (d.total / max) * 100;
          const m = d.total > 0 ? (Math.min(d.mine, d.total) / d.total) * 100 : 0;
          return (
            <button key={d.label + k} type="button" role="listitem" className={`mbar ${k === i ? "on" : ""}`}
              onMouseEnter={() => setActive(k)} onFocus={() => setActive(k)} onClick={() => setActive(k)}
              aria-label={`${d.label}: group ${money(d.total, currency)}, your share ${money(d.mine, currency)}`}>
              <span className="mbar-col">
                {d.total > 0 && <span className="mbar-val" style={{ bottom: `calc(${h}% + 6px)` }}>{moneyShort(d.total, currency)}</span>}
                <span className="mbar-total" style={{ height: `${Math.max(h, d.total > 0 ? 2 : 0)}%` }}>
                  <span className="mbar-mine" style={{ height: `${m}%` }} />
                </span>
              </span>
              <span className="mbar-label">{d.label}</span>
            </button>
          );
        })}
        {empty && <div className="mbars-empty hint">No spending in these months yet.</div>}
      </div>
    </div>
  );
}

/** Diverging bars: who gets money back (right, green) vs who owes (left, red), amounts at the end. */
export function NetBars({ data, currency }: { data: { name: string; value: number }[]; currency: string }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const rows = [...data].sort((a, b) => b.value - a.value);
  return (
    <div className="nbars">
      {rows.map((d) => {
        const w = (Math.abs(d.value) / max) * 50;
        const pos = d.value >= 0;
        return (
          <div className="nbar" key={d.name}>
            <span className="nbar-name" title={d.name}>{d.name}</span>
            <span className="nbar-track">
              <span className={`nbar-fill ${pos ? "pos" : "neg"}`} style={pos ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
            </span>
            <span className={`nbar-val num ${pos ? "pos" : "neg"}`}>{pos ? "+" : "−"}{money(Math.abs(d.value), currency)}</span>
          </div>
        );
      })}
      <div className="nbar-axis"><span /><span className="hint">owes</span><span className="hint">gets back</span><span /></div>
    </div>
  );
}

/** Paid vs share per person: two labelled bars on a shared scale, with the difference on the right. */
export function PaidShareBars({ rows, currency }: {
  rows: { key: string; name: string; avatar: React.ReactNode; paid: number; share: number }[]; currency: string;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.paid, r.share]));
  return (
    <div className="psbars">
      {rows.map((r) => {
        const net = r.paid - r.share;
        return (
          <div className="psrow" key={r.key}>
            <div className="psrow-head">
              <span className="row-flex" style={{ gap: 8, minWidth: 0 }}>{r.avatar}<span className="clamp-2">{r.name}</span></span>
              <span className={`small ${net > 0 ? "pos" : net < 0 ? "neg" : "faint"}`}>{net === 0 ? "even" : net > 0 ? `+${money(net, currency)}` : `−${money(-net, currency)}`}</span>
            </div>
            <div className="psbar"><span className="k">Paid</span><span className="t"><span className="f gold" style={{ width: `${(r.paid / max) * 100}%` }} /></span><span className="v num">{money(r.paid, currency)}</span></div>
            <div className="psbar"><span className="k">Share</span><span className="t"><span className="f blue" style={{ width: `${(r.share / max) * 100}%` }} /></span><span className="v num">{money(r.share, currency)}</span></div>
          </div>
        );
      })}
    </div>
  );
}
