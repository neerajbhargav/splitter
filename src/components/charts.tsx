"use client";
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

/** Donut with a big number in the middle and a legend beside it. */
export function Donut({ data, currency, center, centerLabel, height = 180 }: {
  data: Slice[]; currency: string; center: string; centerLabel: string; height?: number;
}) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const shown = total > 0 ? data : [{ key: "none", name: "Nothing yet", value: 1, color: "var(--surface-3)" }];
  return (
    <div className="donut-grid">
      <div style={{ position: "relative", width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={shown} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="100%" paddingAngle={total > 0 && data.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
              {shown.map((d) => <Cell key={d.key} fill={d.color} />)}
            </Pie>
            {total > 0 && (
              <Tooltip content={({ active, payload }) => active && payload?.length ? (
                <Tip rows={[{ name: String(payload[0].name), value: Number(payload[0].value), color: (payload[0].payload as Slice).color }]} currency={currency} />
              ) : null} />
            )}
          </PieChart>
        </ResponsiveContainer>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ fontFamily: "var(--serif)", fontSize: 28, lineHeight: 1.05 }}>{center}</div>
          <div className="tiny faint">{centerLabel}</div>
        </div>
      </div>
      <div className="legend">
        {data.length ? data.slice(0, 6).map((d) => (
          <div className="legend-row" key={d.key}>
            <i className="sw" style={{ background: d.color }} />
            <span className="nm">{d.name}</span>
            <span className="v">{money(d.value, currency)}</span>
          </div>
        )) : <span className="hint">Nothing to show yet.</span>}
        {data.length > 6 && <span className="tiny faint">+{data.length - 6} more</span>}
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
          <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={({ active, payload, label }) => active && payload?.length ? (
            <Tip title={String(label)} currency={currency} rows={[
              { name: "Group total", value: Number(payload.find((p) => p.dataKey === "total")?.value ?? 0), color: "rgba(240, 234, 224, 0.35)" },
              { name: "Your share", value: Number(payload.find((p) => p.dataKey === "mine")?.value ?? 0), color: "var(--chart-1)" },
            ]} />
          ) : null} />
          <Bar dataKey="total" fill="rgba(240, 234, 224, 0.16)" radius={[6, 6, 2, 2]} maxBarSize={28} isAnimationActive={false} />
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
          <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={({ active, payload }) => active && payload?.length ? (
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
