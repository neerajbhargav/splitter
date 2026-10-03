"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FileUp, Landmark, Plus, RefreshCw } from "lucide-react";
import { Card } from "@/components/kit";
import { Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { connectBank, getPlaidStatus, isReauthError, repairConnection, syncConnection, PlaidClientError, type PlaidStatus } from "@/lib/plaid-client";
import type { FinanceConnection } from "@/lib/finance-types";
import { useFinance } from "./FinanceProvider";
import { errorText } from "./kit";

const DEMO_NOTE = "Sample data can't link banks. Exit the preview to link your own.";

// Ask the server once per page load; a failed check can be retried.
let statusRequest: Promise<PlaidStatus> | null = null;
function loadStatus(): Promise<PlaidStatus> {
  statusRequest ??= getPlaidStatus().catch((e: unknown) => {
    statusRequest = null;
    if (e instanceof PlaidClientError && e.code === "not_configured") return { configured: false, env: null };
    throw e;
  });
  return statusRequest;
}

function syncedAgo(iso: string | null): string {
  if (!iso) return "Not synced yet";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "Synced just now";
  if (mins < 60) return `Synced ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Synced ${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "Synced yesterday";
  if (days < 7) return `Synced ${days} days ago`;
  return `Synced ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

type Running = { id: string; label: string };
const btn36 = { minHeight: 36 } as const;

/** Plaid connections: link, sync, fix login, unlink. */
export function BankLinks() {
  const { bundle, ctx, demo, api, reload } = useFinance();
  const toast = useToast();
  const [status, setStatus] = useState<PlaidStatus | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [progress, setProgress] = useState("");
  const [flowError, setFlowError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  function check() {
    setCheckError(null);
    loadStatus().then(setStatus).catch((e: unknown) => setCheckError(errorText(e)));
  }
  useEffect(check, []);

  async function run(id: string, label: string, flow: () => Promise<string | null>) {
    if (running) return;
    if (demo) { toast.err(new Error(DEMO_NOTE)); return; }
    setRunning({ id, label });
    setProgress("");
    setFlowError(null);
    try {
      const done = await flow();
      if (done) toast.ok(done);
    } catch (e) {
      setFlowError(isReauthError(e) ? "Your bank wants you to sign in again. Use Fix login." : errorText(e));
    } finally {
      setRunning(null);
      setProgress("");
      await reload().catch(() => undefined);
    }
  }

  const link = () => run("new", "Linking", async () => {
    const res = await connectBank({ ...ctx }, setProgress);
    if (!res) return null;
    return `${res.institution} linked with ${res.accounts} account${res.accounts === 1 ? "" : "s"}${res.historyPending ? ". Older history is still on its way." : "."}`;
  });

  const sync = (c: FinanceConnection) => run(c.id, "Syncing", async () => {
    const res = await syncConnection({ ...ctx }, c.id, setProgress);
    return res.upserted || res.removed ? `${c.institution} synced, ${res.upserted} transaction${res.upserted === 1 ? "" : "s"} updated` : `${c.institution} is up to date`;
  });

  const repair = (c: FinanceConnection) => run(c.id, "Fixing login", async () => {
    const res = await repairConnection({ ...ctx }, c.id, setProgress);
    return res ? `${c.institution} is reconnected` : null;
  });

  async function unlink(c: FinanceConnection) {
    if (running) return;
    setRunning({ id: c.id, label: "Unlinking" });
    try {
      await api.deleteConnection(c.id, { ...ctx });
      toast.ok(`${c.institution} unlinked. Its accounts stay as manual records.`);
      setUnlinking(null);
      await reload().catch(() => undefined);
    } catch (e) {
      toast.err(e);
    } finally {
      setRunning(null);
    }
  }

  const csvLink = <Link href="/finance/activity?import=1" className="btn btn-sm" style={btn36}><FileUp /> Import CSV</Link>;
  const sandbox = status?.env === "sandbox";

  return (
    <Card title={<span className="row-flex" style={{ gap: 8 }}>Linked banks{sandbox && <span className="badge gold">Sandbox</span>}</span>}
      description={status?.configured ? "Balances and transactions straight from your bank." : undefined}>
      {checkError ? (
        <div className="stack-sm">
          <p className="hint">Couldn&apos;t check bank linking just now. {checkError}</p>
          <button type="button" className="btn btn-sm" style={btn36} onClick={check}><RefreshCw /> Try again</button>
        </div>
      ) : !status ? (
        <p className="hint row-flex" style={{ gap: 8 }}><Spinner size={14} /> Checking bank linking</p>
      ) : !status.configured ? (
        <div className="stack-sm">
          <p className="hint">Bank linking isn&apos;t switched on for this SPLITTER server yet. Import a CSV in the meantime.</p>
          <div>{csvLink}</div>
        </div>
      ) : (
        <div className="stack-sm">
          {bundle.connections.length > 0 ? (
            <div className="list">
              {bundle.connections.map((c) => {
                const count = bundle.accounts.filter((a) => a.connection_id === c.id).length;
                const busyHere = running?.id === c.id;
                return (
                  <div className="item" key={c.id} style={{ flexWrap: "wrap", rowGap: 10 }}>
                    <span className={`icon-tile ${c.status === "ok" ? "" : "gold"}`}><Landmark /></span>
                    <div className="item-main">
                      <div className="item-title">{c.institution}</div>
                      {c.status === "reauth" ? (
                        <div className="item-sub gold">Login expired</div>
                      ) : c.status === "error" ? (
                        <div className="item-sub neg wrap2">{c.error || "The last sync didn't finish."}</div>
                      ) : (
                        <div className="item-sub">{count} account{count === 1 ? "" : "s"} · {syncedAgo(c.last_synced_at)}</div>
                      )}
                    </div>
                    {unlinking === c.id ? (
                      <div className="fin-inline-edit danger" style={{ flexBasis: "100%" }}>
                        <div>
                          <b>Unlink {c.institution}?</b>
                          <p className="hint" style={{ marginTop: 4 }}>
                            {count ? `Its ${count} account${count === 1 ? "" : "s"} and all history stay here as manual records. They just stop updating.` : "Nothing you've logged is removed."}
                          </p>
                        </div>
                        <div className="row-flex">
                          <button type="button" className="btn btn-sm btn-ghost" style={btn36} onClick={() => setUnlinking(null)}>Keep linked</button>
                          <button type="button" className="btn btn-sm btn-danger" style={btn36} disabled={!!running} onClick={() => void unlink(c)}>{busyHere && <Spinner size={14} />}Unlink</button>
                        </div>
                      </div>
                    ) : (
                      <div className="row-flex" style={{ flexBasis: "100%", gap: 8, paddingLeft: 48, flexWrap: "wrap" }}>
                        {c.status === "reauth" ? (
                          <button type="button" className="btn btn-sm btn-primary" style={btn36} disabled={!!running} onClick={() => void repair(c)}>{busyHere && <Spinner size={14} />}Fix login</button>
                        ) : (
                          <button type="button" className="btn btn-sm" style={btn36} disabled={!!running} onClick={() => void sync(c)}>
                            {busyHere ? <Spinner size={14} /> : <RefreshCw />}{c.status === "error" ? "Try again" : "Sync now"}
                          </button>
                        )}
                        <button type="button" className="btn btn-sm btn-ghost" style={btn36} disabled={!!running}
                          onClick={() => (demo ? toast.err(new Error(DEMO_NOTE)) : setUnlinking(c.id))}>Unlink</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="hint">Link a bank to pull in balances and transactions. You sign in with your bank directly; SPLITTER never sees your password.</p>
          )}
          {running && running.label !== "Unlinking" && (
            <p className="hint row-flex" style={{ gap: 8 }} aria-live="polite"><Spinner size={14} /> {progress || `${running.label}…`}</p>
          )}
          {flowError && <div className="banner neg" role="alert">{flowError}</div>}
          <div className="row-flex" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm" style={btn36} disabled={!!running} onClick={() => void link()}>
              {running?.id === "new" ? <Spinner size={14} /> : <Plus />} Link a bank
            </button>
            {demo && <span className="hint">{DEMO_NOTE}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}
