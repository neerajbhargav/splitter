"use client";
import Link from "next/link";
import { useMemo, type CSSProperties } from "react";
import { Pencil } from "lucide-react";
import { Card } from "@/components/kit";
import { Pill, StatusChip } from "@/components/finance/kit";
import { useFinance } from "@/components/finance/FinanceProvider";
import { CreditScores } from "@/components/finance/CreditScores";
import { money } from "@/lib/format";
import { evaluateHealth, healthScore, netWorth, type RuleResult } from "@/lib/finance-insights";
import { isLiability } from "@/lib/finance-types";

/** Small buttons still get a 36px tap target. */
const TAP: CSSProperties = { height: 36, minHeight: 36 };

type Fix = { label: string; kind: "profile" } | { label: string; kind: "link"; href: string };

/** Which screen fills in the missing number for an unknown rule. */
function fixFor(rule: RuleResult): Fix | null {
  if (!rule.needs) return null;
  const n = rule.needs.toLowerCase();
  if (/account|balance/.test(n)) return { label: "Add accounts", kind: "link", href: "/finance/accounts" };
  if (/gross/.test(n)) return { label: "Add gross pay", kind: "profile" };
  if (/take-home/.test(n)) return { label: "Add take-home", kind: "profile" };
  if (/log|spending|transaction/.test(n)) return { label: "Log spending", kind: "link", href: "/finance/activity" };
  return { label: "Add your numbers", kind: "profile" };
}

function verdict(score: number): string {
  if (score >= 80) return "Strong month";
  if (score >= 50) return "A few things to tighten";
  return "Needs attention";
}

export default function HealthPage() {
  const { bundle, currency, today, settings } = useFinance();
  const s = bundle.settings;

  const view = useMemo(() => {
    const rules = evaluateHealth({
      settings: s,
      accounts: bundle.accounts,
      holdings: bundle.holdings,
      categories: bundle.categories,
      transactions: bundle.transactions,
      today,
      currency,
    });
    const count = { pass: 0, warn: 0, fail: 0, unknown: 0 };
    for (const r of rules) count[r.status]++;
    const known = rules.length - count.unknown;
    const score = known >= 3 ? healthScore(rules) : null;
    // Same definition as the debt-to-income rule: minimums on liabilities that still carry a balance.
    let minimums = 0;
    let debtAccounts = 0;
    for (const a of bundle.accounts) {
      if (!isLiability(a.type) || a.balance_cents <= 0) continue;
      if (a.minimum_cents && a.minimum_cents > 0) {
        minimums += a.minimum_cents;
        debtAccounts++;
      }
    }
    const liquid = netWorth(bundle.accounts, bundle.holdings).liquid;
    return { rules, count, score, minimums, debtAccounts, liquid };
  }, [s, bundle.accounts, bundle.holdings, bundle.categories, bundle.transactions, today, currency]);

  const { rules, count, score, minimums, debtAccounts, liquid } = view;
  const gross = s?.monthly_gross_cents ?? 0;
  const net = s?.monthly_net_cents ?? 0;
  const missingPay = gross <= 0 || net <= 0;
  const tone = score === null ? "var(--gold)" : score >= 80 ? "var(--pos)" : score >= 50 ? "var(--gold)" : "var(--neg)";

  const profileValue = (cents: number) =>
    cents > 0 ? <span className="v num">{money(cents, currency)}</span> : <span className="v faint" style={{ fontFamily: "var(--sans)" }}>Not set</span>;

  return (
    <>
      <section className="card">
        <div className="card-body" style={{ paddingTop: 18 }}>
          <div className="row-flex" style={{ gap: 18, alignItems: "center" }}>
            <div
              className="fin-score"
              style={{ ["--p" as string]: score ?? 0, ["--c" as string]: tone } as CSSProperties}
              role="img"
              aria-label={score === null ? "Not enough information to score yet" : `Health score ${score} out of 100`}
            >
              <div>
                {score === null ? (
                  <span style={{ fontSize: 12, lineHeight: 1.3, padding: "0 10px", color: "var(--ink-2)" }}>Add your numbers</span>
                ) : (
                  <div>
                    <b className="num">{score}</b>
                    <span>of 100</span>
                  </div>
                )}
              </div>
            </div>
            <div className="min0" style={{ flex: 1 }}>
              <div className="eyebrow">This month</div>
              <div className="serif" style={{ fontSize: 24, lineHeight: 1.2, marginTop: 4, overflowWrap: "anywhere" }}>
                {score === null ? "Not enough to score yet" : verdict(score)}
              </div>
              <div className="row-flex" style={{ gap: 6, flexWrap: "wrap", marginTop: 10, fontSize: 12.5 }}>
                <Pill color="var(--pos)" label="On track" value={count.pass} />
                <Pill color="var(--gold)" label="Close" value={count.warn} />
                <Pill color="var(--neg)" label="Off track" value={count.fail} />
              </div>
            </div>
          </div>
          {missingPay && (
            <div className="banner" style={{ marginTop: 16, flexWrap: "wrap", justifyContent: "space-between" }}>
              <span style={{ flex: "1 1 180px", minWidth: 0 }}>
                {gross <= 0 && net <= 0
                  ? "Add your monthly pay to unlock most of these checks."
                  : gross <= 0
                    ? "Add your gross pay to check housing and debt."
                    : "Add your take-home pay to check your budget split."}
              </span>
              <button type="button" className="btn btn-sm" style={TAP} onClick={() => settings.show("profile")}>Add pay</button>
            </div>
          )}
        </div>
      </section>

      <CreditScores />

      <div className="dash-grid">
        <Card title="Six checks" description="Measured on this calendar month.">
          <div>
            {rules.map((r) => {
              const fix = r.status === "unknown" ? fixFor(r) : null;
              return (
                <div key={r.id} className="fin-rule">
                  <div className="min0" style={{ flex: 1 }}>
                    <div className="between" style={{ alignItems: "flex-start" }}>
                      <div className="t min0" style={{ overflowWrap: "anywhere" }}>{r.name}</div>
                      <StatusChip status={r.status} />
                    </div>
                    <div className="a">{r.actual}</div>
                    <div className="x" style={{ marginTop: 4, color: "var(--ink-2)" }}>
                      <span className="faint">Target </span>{r.target}
                    </div>
                    <div className="x">{r.detail}</div>
                    {fix && (
                      <div className="row-flex" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
                        <span className="hint" style={{ flex: "1 1 180px", minWidth: 0 }}>{r.needs}</span>
                        {fix.kind === "profile" ? (
                          <button type="button" className="btn btn-sm" style={TAP} onClick={() => settings.show("profile")}>{fix.label}</button>
                        ) : (
                          <Link href={fix.href} className="btn btn-sm" style={TAP}>{fix.label}</Link>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="dash-col">
          <Card
            title="Your numbers"
            description="Monthly, from your profile and accounts."
            action={
              <button type="button" className="btn btn-sm" style={TAP} onClick={() => settings.show("profile")}>
                <Pencil /> Edit
              </button>
            }
          >
            <div className="list">
              <div className="item">
                <div className="item-main"><div className="item-title">Gross pay</div><div className="item-sub">Before tax</div></div>
                <div className="item-end">{profileValue(gross)}</div>
              </div>
              <div className="item">
                <div className="item-main"><div className="item-title">Take-home pay</div><div className="item-sub">What lands in your account</div></div>
                <div className="item-end">{profileValue(net)}</div>
              </div>
              <div className="item">
                <div className="item-main"><div className="item-title">Rent or mortgage</div></div>
                <div className="item-end">{profileValue(s?.housing_cents ?? 0)}</div>
              </div>
              <div className="item">
                <div className="item-main"><div className="item-title">Car payment</div></div>
                <div className="item-end">{profileValue(s?.car_cents ?? 0)}</div>
              </div>
              <div className="item">
                <div className="item-main">
                  <div className="item-title">Debt minimums</div>
                  <div className="item-sub">
                    {debtAccounts === 0 ? (
                      <Link href="/finance/accounts" className="faint" style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>None on your cards or loans</Link>
                    ) : `Across ${debtAccounts} ${debtAccounts === 1 ? "account" : "accounts"}`}
                  </div>
                </div>
                <div className="item-end"><span className="v num">{money(minimums, currency)}</span></div>
              </div>
              <div className="item">
                <div className="item-main"><div className="item-title">Liquid cash</div><div className="item-sub">Checking, savings and cash</div></div>
                <div className="item-end"><span className={`v num ${liquid < 0 ? "neg" : ""}`}>{money(liquid, currency)}</span></div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <p className="hint" style={{ textAlign: "center", margin: "4px 0 0" }}>
        These are rules of thumb lenders and planners use, not personal advice.
      </p>
    </>
  );
}
