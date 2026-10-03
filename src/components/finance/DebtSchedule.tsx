"use client";
import { useMemo, useState } from "react";
import type { DebtPlan, DebtPlannerDebt } from "@/lib/debt-planner";
import { money } from "@/lib/format";
import { currencySymbol, monthShort } from "@/components/finance/kit";

function bigMoney(c: bigint, currency: string): string {
  const n = Number(c);
  if (Number.isSafeInteger(n)) return money(n, currency);
  return `${currencySymbol(currency)}${(c / 100n).toLocaleString("en-US")}`;
}

export function DebtSchedule({ plan, debts, currency }: { plan: DebtPlan; debts: DebtPlannerDebt[]; currency: string }) {
  const [shown, setShown] = useState(12);
  const names = useMemo(() => new Map(debts.map((d) => [d.id, d.name])), [debts]);
  const total = plan.timeline.length;
  const remaining = total - shown;
  const summary = !plan.is_finite && total >= 600 ? `Show the first ${total} months` : `Show ${total} ${total === 1 ? "month" : "months"}`;

  return (
    <details className="fin-debt-sched">
      <summary>{summary}</summary>
      <div>
        {plan.timeline.slice(0, shown).map((m) => (
          <div key={m.month_number} className="fin-debt-month">
            <div className="fin-debt-mhead">
              <b>{monthShort(m.month)}</b>
              <span className="num">Paid {bigMoney(m.payment_cents, currency)} · Interest {bigMoney(m.interest_cents, currency)}</span>
            </div>
            {m.payments.filter((p) => p.payment_cents > 0n || p.ending_balance_cents > 0n).map((p) => (
              <div key={p.debt_id} className="fin-debt-line">
                <span>{names.get(p.debt_id) ?? "Debt"}</span>
                <span className="num">Paid {bigMoney(p.payment_cents, currency)}</span>
                {p.ending_balance_cents === 0n && p.payment_cents > 0n
                  ? <span className="num pos">Paid off</span>
                  : <span className="num">Left {bigMoney(p.ending_balance_cents, currency)}</span>}
              </div>
            ))}
          </div>
        ))}
        {remaining > 0 && (
          <div className="fin-debt-more">
            <button type="button" className="btn btn-sm" style={{ minHeight: 36 }} onClick={() => setShown((s) => s + 12)}>Show 12 more</button>
            {remaining > 12 && <button type="button" className="btn btn-sm" style={{ minHeight: 36 }} onClick={() => setShown(total)}>Show all</button>}
          </div>
        )}
      </div>
    </details>
  );
}
