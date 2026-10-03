"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal, Spinner, Switch } from "@/components/ui";
import { useToast } from "@/components/providers";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { holdingValueCents } from "@/lib/finance-insights";
import {
  ACCOUNT_TYPE_LABEL, FINANCE_MAX_CENTS, isLiability,
  type AccountType, type FinanceAccount, type FinanceAccountInput, type FinanceHolding,
} from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { MoneyInput, errorText, useDraftContext } from "./kit";

const ASSET_OPTIONS: AccountType[] = ["checking", "savings", "cash", "investment"];
const DEBT_OPTIONS: AccountType[] = ["credit", "loan"];

/* ---------- exact parsing helpers (no floats) ---------- */

/** "24.99" -> 2499 basis points. Empty -> null. Invalid -> undefined. */
export function parseAprBps(input: string): number | null | undefined {
  const t = input.trim().replace(/\s*%$/, "");
  if (!t) return null;
  const m = /^(\d{1,4})(?:\.(\d{0,2}))?$/.exec(t) ?? /^()\.(\d{1,2})$/.exec(t);
  if (!m) return undefined;
  const bps = Number(m[1] || "0") * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return bps > 100_000 ? undefined : bps;
}

/** 2499 -> "24.99", 1800 -> "18" */
export function formatApr(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** "12.50000000" -> "12.5" */
export function formatShares(shares: string): string {
  const s = String(shares).trim();
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

const SHARES_INPUT = /^\d{1,10}(\.\d{1,8})?$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

function safeHoldingValue(h: Pick<FinanceHolding, "shares" | "price_cents">): number | null {
  try { return holdingValueCents(h.shares, h.price_cents); } catch { return null; }
}

type HoldingDraft = { id?: string; symbol: string; name: string; shares: string; price: string };

/** Add or edit one account. Investment accounts also manage their holdings here. */
/** `defaults` pre-fills a NEW account (e.g. Debt page "Add debt" opens as a credit card). Ignored when editing. */
export function AccountEditor({ open, account, defaults, onClose }: { open: boolean; account: FinanceAccount | null; defaults?: Partial<FinanceAccountInput>; onClose: () => void }) {
  const { bundle, currency, api, reload, demo } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [institution, setInstitution] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [balance, setBalance] = useState("");
  const [last4, setLast4] = useState("");
  const [apr, setApr] = useState("");
  const [minimum, setMinimum] = useState("");
  const [inPayoff, setInPayoff] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteRef = useRef<HTMLDivElement>(null);

  const [holding, setHolding] = useState<HoldingDraft | null>(null);
  const [holdingBusy, setHoldingBusy] = useState(false);
  const [holdingError, setHoldingError] = useState<string | null>(null);
  const [holdingConfirm, setHoldingConfirm] = useState(false);

  useEffect(() => {
    if (!open) { draft.release(); return; }
    setCreatedId(null);
    const base = account ?? defaults ?? null;
    setName(base?.name ?? "");
    setInstitution(base?.institution ?? "");
    setType(base?.type ?? "checking");
    setBalance(base?.balance_cents != null && (account || base.balance_cents) ? centsToInput(base.balance_cents) : "");
    setLast4(base?.last4 ?? "");
    setApr(base?.apr_bps != null ? formatApr(base.apr_bps) : "");
    setMinimum(base?.minimum_cents != null ? centsToInput(base.minimum_cents) : "");
    setInPayoff(base?.in_payoff ?? true);
    setConfirmDelete(false);
    setError(null);
    setHolding(null);
    setHoldingError(null);
    setHoldingConfirm(false);
    draft.capture();
    // Reset only when the dialog opens or switches account; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id]);

  useEffect(() => {
    if (confirmDelete) deleteRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [confirmDelete]);

  /** Sample-data mode rejects every write with a friendly message: show it as a toast, not a form error. */
  function fail(e: unknown, show: (msg: string) => void) {
    if (demo) toast.err(e);
    else show(errorText(e));
  }

  const accountId = account?.id ?? createdId;
  const stored = accountId ? bundle.accounts.find((a) => a.id === accountId) ?? account : null;
  const holdings = useMemo(() => (accountId ? bundle.holdings.filter((h) => h.account_id === accountId) : []), [bundle.holdings, accountId]);
  const holdingsTotal = holdings.reduce((sum, h) => sum + (safeHoldingValue(h) ?? 0), 0);
  const valuedByHoldings = type === "investment" && holdings.length > 0;
  const typeLocked = stored?.type === "investment" && holdings.length > 0;
  const liability = isLiability(type);
  const cur = draft.captured?.currency ?? currency;
  const editing = !!accountId;

  async function save() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    const n = name.trim();
    if (!n) return setError("Give the account a name, like Everyday checking.");
    if (n.length > 100) return setError("Keep the name under 100 characters.");
    if (institution.trim().length > 100) return setError("Keep the institution under 100 characters.");
    const l4 = last4.trim();
    if (l4 && !/^[0-9A-Za-z]{2,4}$/.test(l4)) return setError("Last 4 should be 2 to 4 letters or digits.");
    if (typeLocked && type !== "investment") return setError("Remove its holdings before changing the type.");

    let balanceCents: number;
    if (valuedByHoldings) {
      balanceCents = stored?.balance_cents ?? 0;
    } else {
      const parsed = balance.trim() ? parseMoney(balance) : 0;
      if (parsed === null) return setError(liability ? "Enter the amount owed, like 1250.00." : "Enter a balance, like 1250.00.");
      if (liability && parsed < 0) return setError("Enter what you owe as a positive number. Use 0 if it's paid off.");
      if (Math.abs(parsed) > FINANCE_MAX_CENTS) return setError("That amount is too large to track.");
      balanceCents = parsed;
    }

    let aprBps: number | null = null;
    let minimumCents: number | null = null;
    if (liability) {
      const a = parseAprBps(apr);
      if (a === undefined) return setError("Enter the APR as a percent, like 24.99.");
      aprBps = a;
      if (minimum.trim()) {
        const m = parseMoney(minimum);
        if (m === null || m < 0) return setError("Enter the minimum payment, like 35.00.");
        if (m > FINANCE_MAX_CENTS) return setError("That minimum is too large to track.");
        minimumCents = m;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const id = await api.saveAccount({
        id: accountId ?? undefined, name: n, institution: institution.trim(), type, balance_cents: balanceCents,
        last4: l4 || null, apr_bps: aprBps, minimum_cents: minimumCents, in_payoff: liability ? inPayoff : true,
      }, draft.captured);
      if (!accountId && type === "investment") {
        // Keep the dialog open so holdings can be added right away.
        setCreatedId(id);
        await reload();
        toast.ok("Account added. Add what it holds below.");
      } else {
        toast.ok(accountId ? "Account updated" : "Account added");
        onClose();
      }
    } catch (e) {
      fail(e, setError);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!accountId || !draft.captured || draft.stale) return setError(STALE_DRAFT);
    setBusy(true);
    try {
      await api.deleteAccount(accountId, draft.captured);
      toast.ok("Account deleted");
      onClose();
    } catch (e) {
      setConfirmDelete(false);
      fail(e, setError);
    } finally {
      setBusy(false);
    }
  }

  /* ---------- holdings ---------- */
  function editHolding(h: FinanceHolding | null) {
    setHoldingError(null);
    setHoldingConfirm(false);
    setHolding(h
      ? { id: h.id, symbol: h.symbol, name: h.name, shares: formatShares(h.shares), price: centsToInput(h.price_cents) }
      : { symbol: "", name: "", shares: "", price: "" });
  }

  async function saveHolding() {
    if (!holding || !accountId) return;
    if (!draft.captured || draft.stale) return setHoldingError(STALE_DRAFT);
    const symbol = holding.symbol.trim().toUpperCase();
    if (!SYMBOL.test(symbol)) return setHoldingError("Enter a ticker like VTI or BRK.B.");
    const shares = holding.shares.trim().replace(/,/g, "");
    if (!SHARES_INPUT.test(shares) || !/[1-9]/.test(shares)) return setHoldingError("Shares should be a number above zero, up to 8 decimals.");
    const price = parseMoney(holding.price);
    if (price === null || price < 0) return setHoldingError("Enter the price per share, like 245.10.");
    const value = safeHoldingValue({ shares, price_cents: price });
    if (value === null || value > FINANCE_MAX_CENTS) return setHoldingError("That holding is too large to track.");
    if (holding.name.trim().length > 100) return setHoldingError("Keep the name under 100 characters.");
    setHoldingBusy(true);
    setHoldingError(null);
    try {
      await api.saveHolding({ id: holding.id, account_id: accountId, symbol, name: holding.name.trim(), shares, price_cents: price }, draft.captured);
      toast.ok(holding.id ? `${symbol} updated` : `${symbol} added`);
      setHolding(null);
    } catch (e) {
      fail(e, setHoldingError);
    } finally {
      setHoldingBusy(false);
    }
  }

  async function removeHolding() {
    if (!holding?.id) return;
    if (!draft.captured || draft.stale) return setHoldingError(STALE_DRAFT);
    setHoldingBusy(true);
    try {
      await api.deleteHolding(holding.id, draft.captured);
      toast.ok(`${holding.symbol} removed`);
      setHolding(null);
    } catch (e) {
      setHoldingConfirm(false);
      fail(e, setHoldingError);
    } finally {
      setHoldingBusy(false);
    }
  }

  const holdingPreview = holding ? (() => {
    const p = parseMoney(holding.price);
    const s = holding.shares.trim().replace(/,/g, "");
    return p !== null && p >= 0 && SHARES_INPUT.test(s) ? safeHoldingValue({ shares: s, price_cents: p }) : null;
  })() : null;

  const anyBusy = busy || holdingBusy;

  return (
    <Modal open={open} onClose={() => { if (!anyBusy) onClose(); }} title={editing ? "Edit account" : "Add account"}
      footer={(
        <>{editing && !confirmDelete && (
          <button type="button" className="btn btn-ghost btn-icon" style={{ marginRight: "auto" }} aria-label="Delete account" disabled={anyBusy} onClick={() => setConfirmDelete(true)}><Trash2 /></button>
        )}
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={anyBusy}>{createdId ? "Done" : "Cancel"}</button>
          <button type="submit" form="fin-account-form" className="btn btn-primary" disabled={anyBusy || draft.stale}>{busy && <Spinner />}{editing ? "Save" : "Add"}</button></>
      )}>
      <form id="fin-account-form" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <label className="label" htmlFor="fin-acc-name">Name</label>
          <input id="fin-acc-name" className="input" maxLength={100} autoFocus={!account} value={name} onChange={(e) => setName(e.target.value)}
            placeholder={liability ? "Sapphire card, car loan" : "Everyday checking, brokerage"} />
        </div>

        <div className="field">
          <label className="label" htmlFor="fin-acc-type">Type</label>
          <select id="fin-acc-type" className="select" value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            <optgroup label="What you have">
              {ASSET_OPTIONS.map((t) => <option key={t} value={t} disabled={typeLocked && t !== "investment"}>{ACCOUNT_TYPE_LABEL[t]}</option>)}
            </optgroup>
            <optgroup label="What you owe">
              {DEBT_OPTIONS.map((t) => <option key={t} value={t} disabled={typeLocked}>{ACCOUNT_TYPE_LABEL[t]}</option>)}
            </optgroup>
          </select>
          {typeLocked && <span className="hint">This account holds investments. Remove them below to change its type.</span>}
        </div>

        <div className="form-row">
          <div className="field">
            <label className="label" htmlFor="fin-acc-inst">Institution <span className="faint">(optional)</span></label>
            <input id="fin-acc-inst" className="input" maxLength={100} value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Chase, SoFi, Fidelity" />
          </div>
          <div className="field">
            <label className="label" htmlFor="fin-acc-last4">Last 4 <span className="faint">(optional)</span></label>
            <input id="fin-acc-last4" className="input num" maxLength={4} autoComplete="off" value={last4}
              onChange={(e) => setLast4(e.target.value.replace(/[^0-9A-Za-z]/g, "").slice(0, 4))} placeholder="0101" />
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="fin-acc-balance">{liability ? "Amount owed" : "Balance"}</label>
          <MoneyInput id="fin-acc-balance" currency={cur} disabled={valuedByHoldings}
            value={valuedByHoldings ? centsToInput(holdingsTotal) : balance} onChange={setBalance} />
          {valuedByHoldings
            ? <span className="hint">Worked out from the holdings below. Edit those to change it.</span>
            : type === "checking" ? <span className="hint">Overdrawn? Use a minus sign, like -40.00.</span>
            : null}
          {stored?.source === "plaid" && <span className="hint">Linked to your bank, so this refreshes each time it syncs.</span>}
        </div>

        {liability && (
          <>
            <div className="form-row">
              <div className="field">
                <label className="label" htmlFor="fin-acc-apr">APR</label>
                <div style={{ position: "relative" }}>
                  <input id="fin-acc-apr" className="input num" inputMode="decimal" autoComplete="off" value={apr} onChange={(e) => setApr(e.target.value)}
                    placeholder="24.99" style={{ paddingRight: 30 }} />
                  <span aria-hidden className="faint" style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>%</span>
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor="fin-acc-min">Minimum payment</label>
                <MoneyInput id="fin-acc-min" currency={cur} value={minimum} onChange={setMinimum} />
              </div>
            </div>
            <label className="row-flex" style={{ justifyContent: "space-between", gap: 12, minHeight: 44, cursor: "pointer" }}>
              <span className="min0">
                <span style={{ display: "block", fontWeight: 500 }}>Include in payoff plan</span>
                <span className="hint" style={{ display: "block" }}>{apr.trim() && minimum.trim() ? "Debt uses it to plan your payoff order." : "Needs the APR and minimum to plan a payoff."}</span>
              </span>
              <Switch on={inPayoff} onChange={setInPayoff} label="Include in payoff plan" />
            </label>
          </>
        )}

        {type === "investment" && (
          <div className="stack-sm" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <div className="row-flex" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <b style={{ fontWeight: 600 }}>Holdings</b>
              {holdings.length > 0 && <span className="num small muted">{money(holdingsTotal, cur)}</span>}
            </div>
            {!accountId ? (
              <p className="hint">Add the account first, then list what it holds here. Until then the balance above is its value.</p>
            ) : (
              <>
                <p className="hint">{holdings.length ? "The account's value is the total of these." : "Add holdings and the account's value will come from them instead of the balance."}</p>
                {holdings.length > 0 && (
                  <div className="list">
                    {holdings.map((h) => {
                      const v = safeHoldingValue(h);
                      return (
                        <button type="button" key={h.id} className="item clickable" onClick={() => editHolding(h)} disabled={holdingBusy}
                          style={{ width: "calc(100% + 20px)", textAlign: "left", background: "none", border: 0, font: "inherit", color: "inherit" }}>
                          <div className="item-main">
                            <div className="item-title num">{h.symbol}{h.name ? <span className="faint" style={{ fontFamily: "inherit" }}> · {h.name}</span> : null}</div>
                            <div className="item-sub">{formatShares(h.shares)} sh at {money(h.price_cents, cur)}</div>
                          </div>
                          <div className="item-end"><div className="v">{v === null ? "–" : money(v, cur)}</div></div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {holding ? (
                  <div className={`fin-inline-edit ${holdingConfirm ? "danger" : ""}`}
                    onKeyDown={(e) => {
                      // Enter here saves the holding, not the whole account form.
                      if (e.key === "Enter" && e.target instanceof HTMLInputElement) { e.preventDefault(); if (!holdingConfirm) void saveHolding(); }
                    }}>
                    {holdingConfirm ? (
                      <>
                        <div><b>Remove {holding.symbol}?</b><p className="hint" style={{ marginTop: 4 }}>The account&apos;s value drops by this holding.</p></div>
                        <div className="row-flex">
                          <button type="button" className="btn btn-sm btn-ghost" style={{ minHeight: 36 }} onClick={() => setHoldingConfirm(false)}>Keep</button>
                          <button type="button" className="btn btn-sm btn-danger" style={{ minHeight: 36 }} disabled={holdingBusy} onClick={() => void removeHolding()}>{holdingBusy && <Spinner size={14} />}Remove</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="form-row">
                          <div className="field">
                            <label className="label" htmlFor="fin-h-symbol">Ticker</label>
                            <input id="fin-h-symbol" className="input num" autoFocus={!holding.id} maxLength={12} autoCapitalize="characters" autoComplete="off"
                              value={holding.symbol} onChange={(e) => setHolding({ ...holding, symbol: e.target.value.toUpperCase().replace(/\s/g, "") })} placeholder="VTI" />
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="fin-h-shares">Shares</label>
                            <input id="fin-h-shares" className="input num" inputMode="decimal" autoComplete="off" value={holding.shares}
                              onChange={(e) => setHolding({ ...holding, shares: e.target.value })} placeholder="12.5" />
                          </div>
                        </div>
                        <div className="field">
                          <label className="label" htmlFor="fin-h-price">Price per share</label>
                          <MoneyInput id="fin-h-price" currency={cur} value={holding.price} onChange={(price) => setHolding({ ...holding, price })} />
                          {holdingPreview !== null && holdingPreview > 0 && <span className="hint">Worth {money(holdingPreview, cur)}</span>}
                        </div>
                        <div className="field">
                          <label className="label" htmlFor="fin-h-name">Name <span className="faint">(optional)</span></label>
                          <input id="fin-h-name" className="input" maxLength={100} value={holding.name} onChange={(e) => setHolding({ ...holding, name: e.target.value })} placeholder="Total stock market" />
                        </div>
                        {holdingError && <div className="banner neg" role="alert">{holdingError}</div>}
                        <div className="row-flex" style={{ flexWrap: "wrap" }}>
                          {holding.id && (
                            <button type="button" className="btn btn-sm btn-ghost btn-icon" style={{ marginRight: "auto", width: 36, height: 36 }} aria-label={`Remove ${holding.symbol}`}
                              disabled={holdingBusy} onClick={() => setHoldingConfirm(true)}><Trash2 /></button>
                          )}
                          <button type="button" className="btn btn-sm btn-ghost" style={{ minHeight: 36 }} disabled={holdingBusy} onClick={() => setHolding(null)}>Cancel</button>
                          <button type="button" className="btn btn-sm btn-primary" style={{ minHeight: 36 }} disabled={holdingBusy || draft.stale} onClick={() => void saveHolding()}>
                            {holdingBusy && <Spinner size={14} />}{holding.id ? "Save holding" : "Add holding"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <button type="button" className="btn btn-sm" style={{ minHeight: 36, alignSelf: "flex-start" }} onClick={() => editHolding(null)}><Plus /> Add holding</button>
                )}
              </>
            )}
          </div>
        )}

        {confirmDelete && (
          <div ref={deleteRef} className="fin-inline-edit danger">
            <div>
              <b>Delete {stored?.name || "this account"}?</b>
              <p className="hint" style={{ marginTop: 4 }}>
                Its transactions stay in Activity without an account.{holdings.length ? ` Its ${holdings.length} holding${holdings.length === 1 ? "" : "s"} go with it.` : ""}
              </p>
            </div>
            <div className="row-flex">
              <button type="button" className="btn btn-sm btn-ghost" style={{ minHeight: 36 }} onClick={() => setConfirmDelete(false)}>Keep it</button>
              <button type="button" className="btn btn-sm btn-danger" style={{ minHeight: 36 }} disabled={busy} onClick={() => void remove()}>{busy && <Spinner size={14} />}Delete</button>
            </div>
          </div>
        )}

        {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
        {error && <div className="banner neg" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
