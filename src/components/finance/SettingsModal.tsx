"use client";
import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Eye, Plus, Trash2 } from "lucide-react";
import { Modal, Segmented, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { CURRENCIES, centsToInput } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { CATEGORY_KIND_LABEL, FINANCE_MAX_CENTS, type CategoryKind, type FinanceCategory } from "@/lib/finance-types";
import { DEMO_MESSAGE, STALE_DRAFT, sameContext, useFinance, type SettingsSection } from "./FinanceProvider";
import { CategoryTile, MoneyInput, errorText, useDraftContext } from "./kit";

const KINDS: CategoryKind[] = ["needs", "wants", "savings"];

export function SettingsModal() {
  const { settings, demo, setDemo } = useFinance();
  const [section, setSection] = useState<SettingsSection>(settings.section);
  useEffect(() => { if (settings.open) setSection(settings.section); }, [settings.open, settings.section]);
  return (
    <Modal open={settings.open} onClose={settings.hide} title="Finance settings" wide>
      <div className="stack">
        <Segmented<SettingsSection> block value={section} onChange={setSection} options={[
          { id: "profile", label: "Income" }, { id: "categories", label: "Categories" }, { id: "currency", label: "Currency" },
        ]} />
        {section === "profile" && <ProfileForm />}
        {section === "categories" && <CategoryManager />}
        {section === "currency" && <CurrencyForm />}
        <div className="fin-settings-foot">
          {demo
            ? <button type="button" className="btn btn-sm" onClick={() => setDemo(false)}>Exit sample data</button>
            : <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDemo(true)}><Eye /> Explore with sample data</button>}
          <span className="hint">Your finances are private to your account and separate from shared groups.</span>
        </div>
      </div>
    </Modal>
  );
}

function ProfileForm() {
  const { bundle, currency, api, settings } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const s = bundle.settings;
  const [v, setV] = useState({ gross: "", net: "", housing: "", car: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!settings.open) return;
    const fmt = (c?: number) => (c ? centsToInput(c) : "");
    setV({ gross: fmt(s?.monthly_gross_cents), net: fmt(s?.monthly_net_cents), housing: fmt(s?.housing_cents), car: fmt(s?.car_cents) });
    draft.capture();
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.open]);

  async function save() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    const read = (text: string, label: string) => {
      if (!text.trim()) return 0;
      const c = parseMoney(text);
      if (c === null || c < 0 || c > FINANCE_MAX_CENTS) throw new Error(`Enter a valid ${label}`);
      return c;
    };
    try {
      const p = { monthly_gross_cents: read(v.gross, "gross pay"), monthly_net_cents: read(v.net, "take-home pay"), housing_cents: read(v.housing, "housing payment"), car_cents: read(v.car, "car payment") };
      if (p.monthly_gross_cents && p.monthly_net_cents > p.monthly_gross_cents) throw new Error("Take-home pay is usually less than gross pay. Check both numbers.");
      setBusy(true);
      setError(null);
      await api.saveProfile(p, draft.captured);
      toast.ok("Income details saved");
      settings.hide();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof typeof v, label: string, hint: string) => (
    <div className="field">
      <label className="label" htmlFor={`fin-profile-${key}`}>{label}</label>
      <MoneyInput id={`fin-profile-${key}`} currency={draft.captured?.currency ?? currency} value={v[key]} onChange={(x) => setV({ ...v, [key]: x })} />
      <span className="hint">{hint}</span>
    </div>
  );
  return (
    <div className="stack">
      <p className="muted">Monthly numbers power the Health checks and become the starting income for new budgets.</p>
      <div className="form-row">
        {field("gross", "Gross pay per month", "Before tax. Used for housing and debt-to-income.")}
        {field("net", "Take-home pay per month", "What lands in your account.")}
      </div>
      <div className="form-row">
        {field("housing", "Rent or mortgage", "Your monthly housing payment.")}
        {field("car", "Car payment", "Loan or lease. Leave empty if none.")}
      </div>
      {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
      {error && <div className="banner neg" role="alert">{error}</div>}
      <div className="row-flex" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? <Spinner /> : null} Save</button>
      </div>
    </div>
  );
}

function CategoryManager() {
  const { bundle, api, ctx, demo } = useFinance();
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string | null; name: string; kind: CategoryKind } | null>(null);
  const [removing, setRemoving] = useState<{ category: FinanceCategory; reassign: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of bundle.transactions) if (t.category_id) m.set(t.category_id, (m.get(t.category_id) ?? 0) + 1);
    return m;
  }, [bundle.transactions]);
  const visible = bundle.categories.filter((c) => showArchived || !c.archived);
  const archivedCount = bundle.categories.filter((c) => c.archived).length;

  async function run(fn: () => Promise<unknown>, done: string) {
    if (demo) return toast.err(new Error(DEMO_MESSAGE));
    setBusy(true);
    try {
      await fn();
      toast.ok(done);
      setEditing(null);
      setRemoving(null);
    } catch (e) {
      toast.err(e);
    } finally {
      setBusy(false);
    }
  }
  const snapshot = { ...ctx };
  const save = () => editing && run(() => {
    if (!sameContext(snapshot, ctx)) throw new Error(STALE_DRAFT);
    const existing = bundle.categories.find((c) => c.id === editing.id);
    return api.saveCategory({ id: editing.id ?? undefined, name: editing.name.trim(), kind: editing.kind, archived: existing?.archived ?? false }, snapshot);
  }, editing.id ? "Category updated" : "Category added");

  return (
    <div className="stack">
      <div className="between">
        <p className="muted" style={{ margin: 0 }}>Categories carry across every month, so history and budgets stay comparable.</p>
        <button type="button" className="btn btn-sm" onClick={() => setEditing({ id: null, name: "", kind: "wants" })}><Plus /> Add</button>
      </div>
      {editing && (
        <div className="fin-inline-edit">
          <input className="input" autoFocus maxLength={40} placeholder="Category name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Category name" />
          <Segmented<CategoryKind> value={editing.kind} onChange={(kind) => setEditing({ ...editing, kind })} options={KINDS.map((k) => ({ id: k, label: CATEGORY_KIND_LABEL[k] }))} />
          <div className="row-flex">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !editing.name.trim()} onClick={() => void save()}>Save</button>
          </div>
        </div>
      )}
      {KINDS.map((kind) => {
        const rows = visible.filter((c) => c.kind === kind);
        if (!rows.length) return null;
        return (
          <div key={kind}>
            <div className="month-label">{CATEGORY_KIND_LABEL[kind]}</div>
            <div className="list">
              {rows.map((c) => (
                <div className={`item ${c.archived ? "fin-archived" : ""}`} key={c.id}>
                  <CategoryTile category={c} size="sm" />
                  <div className="item-main">
                    <div className="item-title">{c.name}{c.archived && <span className="badge" style={{ marginLeft: 8 }}>Archived</span>}</div>
                    <div className="item-sub">{usage.get(c.id) ? `${usage.get(c.id)} transaction${usage.get(c.id) === 1 ? "" : "s"}` : "Not used yet"}</div>
                  </div>
                  <div className="row-flex" style={{ gap: 4 }}>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing({ id: c.id, name: c.name, kind: c.kind })}>Edit</button>
                    <button type="button" className="btn btn-sm btn-ghost btn-icon" title={c.archived ? "Restore" : "Archive (hide from pickers)"} aria-label={c.archived ? `Restore ${c.name}` : `Archive ${c.name}`}
                      onClick={() => void run(() => api.saveCategory({ id: c.id, name: c.name, kind: c.kind, archived: !c.archived }, { ...ctx }), c.archived ? "Category restored" : "Category archived")}>
                      {c.archived ? <ArchiveRestore /> : <Archive />}
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Delete ${c.name}`} onClick={() => setRemoving({ category: c, reassign: "" })}><Trash2 /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {archivedCount > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "Hide archived" : `Show ${archivedCount} archived`}</button>}
      {removing && (
        <div className="fin-inline-edit danger">
          <div><b>Delete {removing.category.name}?</b>
            <p className="hint" style={{ marginTop: 4 }}>{usage.get(removing.category.id) ? `Its ${usage.get(removing.category.id)} transactions and any budget limit move to the category you pick.` : "It isn't used by any transactions."}</p></div>
          <select className="select" value={removing.reassign} onChange={(e) => setRemoving({ ...removing, reassign: e.target.value })} aria-label="Move its transactions to">
            <option value="">Leave them uncategorized</option>
            {bundle.categories.filter((c) => c.id !== removing.category.id && !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="row-flex">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(null)}>Keep it</button>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void run(() => api.deleteCategory(removing.category.id, removing.reassign || null, { ...ctx }), "Category deleted")}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CurrencyForm() {
  const { bundle, currency, api, userId, settings, demo } = useFinance();
  const toast = useToast();
  const [value, setValue] = useState(currency);
  const [busy, setBusy] = useState(false);
  const s = bundle.settings;
  const locked = bundle.accounts.length + bundle.transactions.length + bundle.subscriptions.length + bundle.budgets.length + bundle.holdings.length > 0
    || !!(s && (s.monthly_gross_cents || s.monthly_net_cents || s.housing_cents || s.car_cents));
  useEffect(() => setValue(currency), [currency, settings.open]);
  return (
    <div className="stack">
      <div className="field">
        <label className="label" htmlFor="fin-currency">Currency for every finance tool</label>
        <select id="fin-currency" className="select" value={value} disabled={locked || busy} onChange={(e) => setValue(e.target.value)}>
          {Array.from(new Set([...CURRENCIES, currency])).map((c) => <option key={c}>{c}</option>)}
        </select>
        <span className="hint">{locked ? "Locked once you have records. Relabeling would not convert existing amounts." : "Pick it before adding anything. Group currencies are separate."}</span>
      </div>
      <div className="row-flex" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-primary" disabled={locked || busy || value === currency} onClick={async () => {
          if (demo) return toast.err(new Error(DEMO_MESSAGE));
          setBusy(true);
          try { await api.saveSettings({ userId, currency: value }); toast.ok(`Finance currency set to ${value}`); settings.hide(); }
          catch (e) { toast.err(e); } finally { setBusy(false); }
        }}>Save currency</button>
      </div>
    </div>
  );
}
