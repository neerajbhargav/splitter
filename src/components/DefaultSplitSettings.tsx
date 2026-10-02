"use client";
import { useEffect, useState, type FormEvent } from "react";
import { RotateCcw } from "lucide-react";
import { Avatar, Segmented } from "./ui";
import { useToast } from "./providers";
import { api } from "@/lib/data";
import type { DefaultSplit, Group, Member } from "@/lib/types";

type SplitMode = DefaultSplit["type"];

function evenPercent(ids: string[]): Record<string, string> {
  if (!ids.length) return {};
  const unit = Math.floor(10000 / ids.length);
  return Object.fromEntries(ids.map((id, i) => [id, String((unit + (i < 10000 % ids.length ? 1 : 0)) / 100)]));
}

export function DefaultSplitSettings({ group, members }: { group: Group; members: Member[] }) {
  const toast = useToast();
  const active = members.filter((m) => m.is_active);
  const saved = group.default_split ?? null;
  const savedKey = JSON.stringify(saved);
  const [mode, setMode] = useState<SplitMode>(saved?.type ?? "equal");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(
    saved ? saved.members.map((m) => m.member_id) : active.map((m) => m.id),
  ));
  const [weights, setWeights] = useState<Record<string, string>>(() => saved
    ? Object.fromEntries(saved.members.map((m) => [m.member_id, String(m.weight)]))
    : Object.fromEntries(active.map((m) => [m.id, "1"])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Respond to a persisted default change, not every realtime refetch of the group.
  useEffect(() => {
    setMode(saved?.type ?? "equal");
    setSelected(new Set(saved ? saved.members.map((m) => m.member_id) : active.map((m) => m.id)));
    setWeights(saved ? Object.fromEntries(saved.members.map((m) => [m.member_id, String(m.weight)]))
      : Object.fromEntries(active.map((m) => [m.id, "1"])));
    setError(null);
  }, [group.id, savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const people = active.filter((m) => selected.has(m.id));
  const validWeights = people.every((m) => {
    const n = Number(weights[m.id] ?? "0");
    return Number.isFinite(n) && n >= 0;
  });
  const sum = people.reduce((n, m) => n + Number(weights[m.id] ?? "0"), 0);
  const problem = !people.length ? "Choose at least one active member."
    : mode !== "equal" && (!validWeights || !Number.isFinite(sum)) ? "Weights must be finite, nonnegative numbers."
    : mode === "percent" && Math.abs(sum - 100) > 0.001 ? "Percentages must add up to 100%."
    : mode === "shares" && sum <= 0 ? "Give at least one selected person a positive share."
    : null;
  const stale = saved?.members.filter((s) => !active.some((m) => m.id === s.member_id)) ?? [];

  function changeMode(next: SplitMode) {
    setMode(next);
    if (next === "percent") setWeights(evenPercent(people.map((m) => m.id)));
    else if (next === "shares") setWeights(Object.fromEntries(people.map((m) => [m.id, "1"])));
    setError(null);
  }

  function toggle(id: string) {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!(id in weights)) setWeights((old) => ({ ...old, [id]: mode === "shares" ? "1" : "0" }));
    setError(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await api.saveDefaultSplit(group.id, {
        type: mode,
        members: people.map((m) => ({ member_id: m.id, weight: mode === "equal" ? 1 : Number(weights[m.id] ?? "0") })),
      });
      toast.ok("Default split saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveDefaultSplit(group.id, null);
      setMode("equal");
      setSelected(new Set(active.map((m) => m.id)));
      setWeights(Object.fromEntries(active.map((m) => [m.id, "1"])));
      toast.ok("Default reset to equal split across active members");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="card-head"><span className="card-title">Default split</span></div>
      <div className="card-body stack">
        <p className="hint" style={{ margin: 0 }}>
          New expenses in this group start with these people and proportions. You can change any expense's split before saving; existing expenses stay untouched.
        </p>
        {stale.length > 0 && (
          <div className="banner" role="status">
            The saved default includes {stale.length === 1 ? "a former or inactive member" : `${stale.length} former or inactive members`}.
            They are excluded below. Review the proportions and save an updated default.
          </div>
        )}
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="stack-sm">
          <div className="between wrap">
            <span className="label">Split method</span>
            <Segmented<SplitMode> value={mode} onChange={changeMode} options={[
              { id: "equal", label: "Equally" },
              { id: "percent", label: "Percent" },
              { id: "shares", label: "Shares" },
            ]} />
          </div>
          <div className="list">
            {active.map((m) => (
              <div key={m.id} className="item" style={{ gap: 10 }}>
                <label className="check">
                  <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} aria-label={`Include ${m.display_name} in default split`} />
                </label>
                <Avatar name={m.display_name} color={m.color} size={26} />
                <span className="item-main ellipsis">{m.display_name}</span>
                {mode !== "equal" && (
                  <div className="row-flex" style={{ flexShrink: 0, width: 112, gap: 6 }}>
                    <input className="input input-sm num" inputMode="decimal" disabled={!selected.has(m.id)}
                      aria-label={`${m.display_name} default ${mode === "percent" ? "percentage" : "shares"}`}
                      value={weights[m.id] ?? "0"} onChange={(e) => { setWeights({ ...weights, [m.id]: e.target.value }); setError(null); }} />
                    {mode === "percent" && <span className="faint">%</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="between wrap">
            <span className={problem ? "hint neg" : "hint"} role="status">
              {problem ?? (mode === "equal" ? `Split evenly across ${people.length} ${people.length === 1 ? "person" : "people"}.`
                : mode === "percent" ? "100% assigned." : `${Number(sum.toFixed(4))} total shares.`)}
            </span>
            <button type="button" className="link-btn" onClick={() => {
              const ids = active.map((m) => m.id);
              setSelected(new Set(ids));
              if (mode === "percent") setWeights(evenPercent(ids));
              else if (mode === "shares") setWeights(Object.fromEntries(ids.map((id) => [id, "1"])));
            }}>Include everyone{mode === "equal" ? "" : " equally"}</button>
          </div>
          {mode === "percent" && <button type="button" className="link-btn" style={{ alignSelf: "flex-start" }}
            onClick={() => setWeights(evenPercent(people.map((m) => m.id)))}>Even out selected people</button>}
          <div className="row-flex wrap">
            <button type="submit" className="btn btn-primary" disabled={!!problem || !active.length}>{busy ? "Saving..." : "Save default split"}</button>
            <button type="button" className="btn btn-ghost" disabled={!saved} onClick={reset}><RotateCcw /> Reset default</button>
          </div>
        </fieldset>
        {!active.length && <div className="hint">Add an active member before saving a default split.</div>}
        {error && <div className="banner neg" role="alert">{error}</div>}
      </div>
    </form>
  );
}
