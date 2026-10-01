"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Profile } from "@/lib/types";

// ---------- current user ----------
type Me = { id: string; email: string | null; profile: Profile | null; setProfile: (p: Profile) => void };
const MeContext = createContext<Me | null>(null);

export function MeProvider({ id, email, profile: initial, children }: { id: string; email: string | null; profile: Profile | null; children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(initial);
  const value = useMemo(() => ({ id, email, profile, setProfile }), [id, email, profile]);
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe must be used inside MeProvider");
  return me;
}

// ---------- toasts ----------
type Toast = { id: number; text: string; tone: "ok" | "err"; action?: { label: string; run: () => void } };
type ToastApi = { ok: (text: string, action?: Toast["action"]) => void; err: (e: unknown) => void };
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setToasts((list) => [...list.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.action ? 6000 : 3200);
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      ok: (text, action) => push({ text, tone: "ok", action }),
      err: (e) => push({ text: e instanceof Error ? e.message : String(e), tone: "err" }),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === "err" ? "err" : ""}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.run();
                  setToasts((l) => l.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast must be used inside ToastProvider");
  return t;
}
