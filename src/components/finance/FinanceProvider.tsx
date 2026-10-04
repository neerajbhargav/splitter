"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMe } from "@/components/providers";
import { supabaseBrowser } from "@/lib/supabase/client";
import { financeApi, FinanceContextError, loadFinance, type FinanceApi } from "@/lib/finance-data";
import { demoBundle } from "@/lib/finance-demo";
import { useLiveRefresh } from "@/lib/data";
import { todayISO } from "@/lib/format";
import type { FinanceBundle, FinanceContext } from "@/lib/finance-types";

const DEMO_KEY = "splitter-finance-demo";
export const DEMO_MESSAGE = "This is sample data, so nothing is saved. Exit the preview to use your own finances.";

export type SettingsSection = "profile" | "categories" | "currency";

type FinanceValue = {
  bundle: FinanceBundle;
  currency: string;
  userId: string;
  /** Live account + currency. Drafts capture a copy when they open and compare before saving. */
  ctx: FinanceContext;
  today: string;
  demo: boolean;
  setDemo: (on: boolean) => void;
  reload: () => Promise<void>;
  /** Same API as financeApi, but every write rejects in sample-data mode. */
  api: FinanceApi;
  settings: { open: boolean; section: SettingsSection; show: (section?: SettingsSection) => void; hide: () => void };
};

const Ctx = createContext<FinanceValue | null>(null);

export function useFinance(): FinanceValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useFinance must be used inside the finance layout");
  return value;
}

export function sameContext(a: FinanceContext | null | undefined, b: FinanceContext): a is FinanceContext {
  return !!a && a.userId === b.userId && a.currency === b.currency;
}
export const STALE_DRAFT = "Your account or finance currency changed while this was open. Close it and open it again.";

const demoApi = new Proxy(financeApi, {
  get: () => async () => {
    throw new Error(DEMO_MESSAGE);
  },
}) as FinanceApi;

type LoadState = { status: "loading" } | { status: "ready"; bundle: FinanceBundle } | { status: "error"; message: string; accountChanged: boolean };

export function FinanceProvider({ children, fallback, failure }: {
  children: ReactNode;
  fallback: ReactNode;
  failure: (message: string, retry: () => void, accountChanged: boolean) => ReactNode;
}) {
  const me = useMe();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [demo, setDemoState] = useState(false);
  const [today, setToday] = useState(todayISO);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("profile");
  const request = useRef(0);
  const ensured = useRef(false);
  const profileCurrency = /^[A-Z]{3}$/.test(me.profile?.default_currency ?? "") ? me.profile!.default_currency : "USD";

  useEffect(() => {
    try { setDemoState(sessionStorage.getItem(DEMO_KEY) === "1"); } catch { /* storage blocked */ }
    const tick = setInterval(() => setToday(todayISO()), 60_000);
    return () => clearInterval(tick);
  }, []);

  const reload = useCallback(async () => {
    const id = ++request.current;
    try {
      let data = await loadFinance(me.id);
      // First visit: create the private workspace and Folio's default categories once.
      if ((!data.settings || !data.settings.categories_seeded) && !ensured.current) {
        ensured.current = true;
        await financeApi.ensureWorkspace({ userId: me.id, currency: data.settings?.currency ?? profileCurrency });
        data = await loadFinance(me.id);
      }
      if (id === request.current) setState({ status: "ready", bundle: data });
    } catch (error) {
      if (id !== request.current) return;
      const accountChanged = error instanceof FinanceContextError;
      setState({ status: "error", message: error instanceof Error ? error.message : "Could not load your finances.", accountChanged });
    }
  }, [me.id, profileCurrency]);

  useEffect(() => {
    setState({ status: "loading" });
    void reload();
    return () => { request.current++; };
  }, [reload]);

  useEffect(() => {
    const { data } = supabaseBrowser().auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== me.id) {
        request.current++;
        setSettingsOpen(false);
        setState({ status: "error", message: "Your signed-in account changed. Reload the app before using your finances.", accountChanged: true });
      }
    });
    return () => data.subscription.unsubscribe();
  }, [me.id]);

  useLiveRefresh("personal-finance", [
    { table: "finance_settings", filter: `user_id=eq.${me.id}` },
    { table: "finance_credit_scores", filter: `user_id=eq.${me.id}` },
  ], () => void reload(), !demo);

  const setDemo = useCallback((on: boolean) => {
    setDemoState(on);
    setSettingsOpen(false);
    try { if (on) sessionStorage.setItem(DEMO_KEY, "1"); else sessionStorage.removeItem(DEMO_KEY); } catch { /* storage blocked */ }
  }, []);

  const real = state.status === "ready" && state.bundle.user_id === me.id ? state.bundle : null;
  const sample = useMemo(() => (demo ? demoBundle(today, me.id) : null), [demo, today, me.id]);
  const bundle = sample ?? real;
  const currency = bundle?.settings?.currency ?? profileCurrency;

  const value = useMemo<FinanceValue | null>(() => bundle && ({
    bundle,
    currency,
    userId: me.id,
    ctx: { userId: me.id, currency },
    today,
    demo,
    setDemo,
    reload,
    api: demo ? demoApi : financeApi,
    settings: {
      open: settingsOpen,
      section: settingsSection,
      show: (section = "profile") => { setSettingsSection(section); setSettingsOpen(true); },
      hide: () => setSettingsOpen(false),
    },
  }), [bundle, currency, me.id, today, demo, setDemo, reload, settingsOpen, settingsSection]);

  if (!demo && state.status === "error") {
    return <>{failure(state.message, () => (state.accountChanged ? window.location.reload() : void reload()), state.accountChanged)}</>;
  }
  if (!value) return <>{fallback}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
