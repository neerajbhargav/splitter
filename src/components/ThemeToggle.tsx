"use client";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { getThemePref, setThemePref, type ThemePref } from "@/lib/theme";

const OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Device", icon: Monitor },
];

function useThemePref() {
  const [pref, setPref] = useState<ThemePref>("system");
  useEffect(() => {
    const sync = () => setPref(getThemePref());
    sync();
    window.addEventListener("splitter-theme", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("splitter-theme", sync); window.removeEventListener("storage", sync); };
  }, []);
  return [pref, (p: ThemePref) => { setThemePref(p); setPref(p); }] as const;
}

/** Light / Dark / Device segmented control. */
export function ThemeToggle() {
  const [pref, set] = useThemePref();
  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={pref === o.value} className={pref === o.value ? "on" : ""} onClick={() => set(o.value)}>
          <o.icon /> {o.label}
        </button>
      ))}
    </div>
  );
}

/** Compact icon button that cycles Light -> Dark -> Device. */
export function ThemeCycle() {
  const [pref, set] = useThemePref();
  const i = OPTIONS.findIndex((o) => o.value === pref);
  const cur = OPTIONS[i < 0 ? 2 : i];
  const next = OPTIONS[((i < 0 ? 2 : i) + 1) % OPTIONS.length];
  return (
    <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => set(next.value)}
      title={`Theme: ${cur.label}. Switch to ${next.label}`} aria-label={`Theme: ${cur.label}. Switch to ${next.label}`}>
      <cur.icon />
    </button>
  );
}
