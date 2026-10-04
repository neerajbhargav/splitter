"use client";
import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_COLORS } from "@/components/charts";
import { money, moneyShort } from "@/lib/format";
import { shortDay } from "./kit";

/** Copilot-style daily spending: flat-bottom bars, the hovered/tapped day is read out above the chart. */
export function DailyBars({ data, currency, height = 150 }: { data: { date: string; cents: number }[]; currency: string; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const total = data.reduce((a, d) => a + d.cents, 0);
  const days = data.filter((d) => d.cents > 0).length;
  const peak = data.reduce<{ date: string; cents: number } | null>((m, d) => (!m || d.cents > m.cents ? d : m), null);
  const cur = active !== null ? data[active] : null;
  return (
    <div>
      <div className="mbars-read" aria-live="polite">
        {cur ? (
          <><span className="mbars-month">{shortDay(cur.date)}</span><span>Spent <b className="num">{money(cur.cents, currency)}</b></span></>
        ) : (
          <>
            <span>Avg per day <b className="num">{money(Math.round(total / Math.max(1, data.length)), currency)}</b></span>
            {peak && peak.cents > 0 && <span>Biggest day <b className="num">{money(peak.cents, currency)}</b> <span className="faint">{shortDay(peak.date)}</span></span>}
            <span className="faint">{days} of {data.length} days with spending</span>
          </>
        )}
      </div>
      <div className="chart-wrap" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barCategoryGap="18%"
            onMouseMove={(st) => { const n = Number(st?.activeTooltipIndex); if (Number.isInteger(n)) setActive(n); }}
            onMouseLeave={() => setActive(null)}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" tickLine={false} axisLine={{ stroke: "var(--line-2)" }} tick={{ fill: "var(--ink-3)", fontSize: 11 }}
              interval="preserveStartEnd" minTickGap={28} tickFormatter={(d: string) => shortDay(d)} />
            <YAxis width={44} tickLine={false} axisLine={false} tick={{ fill: "var(--ink-3)", fontSize: 11 }} tickFormatter={(v) => moneyShort(Number(v), currency)} />
            <Bar dataKey="cents" fill="var(--gold)" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {data.map((d, k) => <Cell key={d.date} fillOpacity={active === null || active === k ? 1 : 0.4} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Stacked remaining balance per debt, so you can see each one disappear in payoff order. */
export function PayoffChart({ data, series, currency, height = 240 }: {
  data: Record<string, number | string>[]; series: { key: string; name: string }[]; currency: string; height?: number;
}) {
  return (
    <div>
      <div className="row-flex wrap" style={{ gap: "6px 14px", marginBottom: 10 }}>
        {series.map((s, i) => <span key={s.key} className="fin-legend-row"><i style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />{s.name}</span>)}
      </div>
      <div className="chart-wrap" style={{ height }} role="img" aria-label="Remaining balance of each debt over time">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--line-2)" }} tick={{ fill: "var(--ink-3)", fontSize: 11 }} interval="preserveStartEnd" minTickGap={30} />
            <YAxis width={50} tickLine={false} axisLine={false} tick={{ fill: "var(--ink-3)", fontSize: 11 }} tickFormatter={(v) => moneyShort(Number(v), currency)} />
            <Tooltip cursor={{ stroke: "var(--line-2)" }} content={({ active, payload, label }) => active && payload?.length ? (
              <div className="chart-tip">
                <div className="t">{label}</div>
                {payload.filter((p) => Number(p.value) > 0).map((p) => (
                  <div className="r" key={String(p.dataKey)}><span><i className="sw" style={{ background: String(p.color) }} />{p.name}</span><b className="num">{money(Number(p.value), currency)}</b></div>
                ))}
                {payload.every((p) => Number(p.value) === 0) && <div className="r"><span>Debt-free</span></div>}
              </div>
            ) : null} />
            {series.map((s, i) => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stackId="debt" stroke={CHART_COLORS[i % CHART_COLORS.length]}
                fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.22} strokeWidth={1.5} isAnimationActive={false} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Credit score history, one line per bureau. Scores are points, not money. */
export type ScorePoint = { date: string; equifax?: number; experian?: number; transunion?: number };
const SCORE_LINES = [
  { key: "equifax", name: "Equifax", color: "var(--chart-1)" },
  { key: "experian", name: "Experian", color: "var(--chart-2)" },
  { key: "transunion", name: "TransUnion", color: "var(--chart-3)" },
] as const;

export function ScoreChart({ data, height = 220 }: { data: ScorePoint[]; height?: number }) {
  const values = data.flatMap((d) => SCORE_LINES.map((l) => d[l.key]).filter((v): v is number => typeof v === "number"));
  const lo = values.length ? Math.min(...values) : 600;
  const hi = values.length ? Math.max(...values) : 800;
  const pad = Math.max(10, Math.round((hi - lo) * 0.25));
  const domain: [number, number] = [Math.max(250, Math.floor((lo - pad) / 10) * 10), Math.min(900, Math.ceil((hi + pad) / 10) * 10)];
  const present = SCORE_LINES.filter((l) => data.some((d) => typeof d[l.key] === "number"));
  const multiYear = data.length > 0 && data[0].date.slice(0, 4) !== data[data.length - 1].date.slice(0, 4);
  const tick = (d: string) => multiYear
    ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" })
    : shortDay(d);
  return (
    <div>
      <div className="row-flex wrap" style={{ gap: "6px 14px", marginBottom: 10 }}>
        {present.map((l) => <span key={l.key} className="fin-legend-row"><i style={{ background: l.color }} />{l.name}</span>)}
      </div>
      <div className="chart-wrap" style={{ height }} role="img" aria-label="Credit scores over time for each bureau">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" tickLine={false} axisLine={{ stroke: "var(--line-2)" }} tick={{ fill: "var(--ink-3)", fontSize: 11 }}
              interval="preserveStartEnd" minTickGap={30} tickFormatter={tick} />
            <YAxis width={36} domain={domain} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--ink-3)", fontSize: 11 }} />
            <Tooltip cursor={{ stroke: "var(--line-2)" }} content={({ active, payload, label }) => active && payload?.length ? (
              <div className="chart-tip">
                <div className="t">{new Date(`${String(label)}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                {payload.filter((p) => typeof p.value === "number").map((p) => (
                  <div className="r" key={String(p.dataKey)}><span><i className="sw" style={{ background: String(p.color) }} />{p.name}</span><b className="num">{String(p.value)}</b></div>
                ))}
              </div>
            ) : null} />
            {present.map((l) => (
              <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} strokeWidth={2} connectNulls
                dot={{ r: 2.5, fill: l.color, strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
