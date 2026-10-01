"use client";
import { useState } from "react";
// shadcn/ui-style chart building blocks on Recharts.
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money } from "@/lib/format";

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

/** Monthly bars: total spend, with your share highlighted. */
export function MonthlyBars({ data, currency, height = 200 }: {
  data: { label: string; total: number; mine: number }[]; currency: string; height?: number;
}) {
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barGap={4}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--ink-3)", fontSize: 12 }} />
          <YAxis hide />
          <Tooltip wrapperStyle={{ zIndex: 20, outline: "none" }} cursor={{ fill: "var(--hover-fill)" }} content={({ active, payload, label }) => active && payload?.length ? (
            <Tip title={String(label)} currency={currency} rows={[
              { name: "Group total", value: Number(payload.find((p) => p.dataKey === "total")?.value ?? 0), color: "var(--bar-muted-2)" },
              { name: "Your share", value: Number(payload.find((p) => p.dataKey === "mine")?.value ?? 0), color: "var(--chart-1)" },
            ]} />
          ) : null} />
          <Bar dataKey="total" fill="var(--bar-muted)" radius={[6, 6, 2, 2]} maxBarSize={28} isAnimationActive={false} />
          <Bar dataKey="mine" fill="var(--chart-1)" radius={[6, 6, 2, 2]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Diverging horizontal bars: who gets money back (right, green) vs who owes (left, red). */
export function NetBars({ data, currency }: { data: { name: string; value: number }[]; currency: string }) {
  const height = Math.max(120, data.length * 34 + 16);
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 4 }} barCategoryGap={8}>
          <XAxis type="number" hide domain={[-max, max]} />
          <YAxis type="category" dataKey="name" width={92} tickLine={false} axisLine={false} tick={{ fill: "var(--ink-2)", fontSize: 12.5 }} />
          <ReferenceLine x={0} stroke="var(--line-2)" />
          <Tooltip wrapperStyle={{ zIndex: 20, outline: "none" }} cursor={{ fill: "var(--hover-fill)" }} content={({ active, payload }) => active && payload?.length ? (
            <Tip title={String(payload[0].payload.name)} currency={currency} rows={[{ name: Number(payload[0].value) >= 0 ? "Gets back" : "Owes", value: Math.abs(Number(payload[0].value)), color: Number(payload[0].value) >= 0 ? "var(--pos)" : "var(--neg)" }]} />
          ) : null} />
          <Bar dataKey="value" radius={6} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.name} fill={d.value >= 0 ? "var(--pos)" : "var(--neg)"} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
