// Theme preference: "light", "dark" or "system" (follow the device). Stored in localStorage.
export type ThemePref = "light" | "dark" | "system";
export const THEME_KEY = "splitter-theme";
export const THEME_COLORS = { light: "#f5f0e6", dark: "#0b0b0c" } as const;

/** Runs inline in <head> before first paint so there is no flash of the wrong theme. */
export const THEME_BOOT = `(function(){try{
var K=${JSON.stringify(THEME_KEY)},C=${JSON.stringify(THEME_COLORS)},m=window.matchMedia('(prefers-color-scheme: light)');
function pref(){var p=localStorage.getItem(K);return p==='light'||p==='dark'?p:'system';}
function apply(){var p=pref(),t=p==='system'?(m.matches?'light':'dark'):p,r=document.documentElement;
r.setAttribute('data-theme',t);r.setAttribute('data-theme-pref',p);r.style.colorScheme=t;
var ms=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<ms.length;i++)ms[i].setAttribute('content',C[t]);}
apply();m.addEventListener('change',apply);window.__splitterTheme=apply;
window.addEventListener('storage',function(e){if(e.key===K||e.key===null)apply();});
document.addEventListener('DOMContentLoaded',apply);
}catch(e){}})();`;

export function getThemePref(): ThemePref {
  if (typeof window === "undefined") return "system";
  const p = localStorage.getItem(THEME_KEY);
  return p === "light" || p === "dark" ? p : "system";
}

export function setThemePref(p: ThemePref) {
  if (p === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, p);
  (window as unknown as { __splitterTheme?: () => void }).__splitterTheme?.();
  window.dispatchEvent(new Event("splitter-theme"));
}
