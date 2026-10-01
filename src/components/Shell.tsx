"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Activity, LayoutDashboard, LogOut, Plus, Settings, Users } from "lucide-react";
import { MeProvider, useMe, useToast } from "./providers";
import { Avatar, LogoMark } from "./ui";
import { ThemeCycle } from "./ThemeToggle";
import { ExpenseEditor } from "./ExpenseEditor";
import { api, loadGroupsLite, loadProfile, useLiveRefresh } from "@/lib/data";
import { supabaseBrowser } from "@/lib/supabase/client";
import { groupKind } from "@/lib/categories";
import type { Group, Profile } from "@/lib/types";

type QuickAdd = { open: (groupId?: string | null) => void; groups: Group[] };
const QuickAddContext = createContext<QuickAdd>({ open: () => {}, groups: [] });
export const useQuickAdd = () => useContext(QuickAddContext);

export function Shell({ user, profile, children }: { user: { id: string; email: string | null }; profile: Profile | null; children: ReactNode }) {
  return (
    <MeProvider id={user.id} email={user.email} profile={profile}>
      <Frame>{children}</Frame>
    </MeProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const me = useMe();
  const toast = useToast();
  const path = usePathname();
  const router = useRouter();
  const [groups, setGroups] = useState<Group[]>([]);
  const [quick, setQuick] = useState<{ open: boolean; gid: string | null }>({ open: false, gid: null });

  const reload = useCallback(() => {
    loadGroupsLite().then(setGroups).catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  useLiveRefresh("shell", [{ table: "groups" }, { table: "group_members", filter: `user_id=eq.${me.id}` }], reload);

  // First load: make sure a profile exists, then create any recurring expenses that came due.
  useEffect(() => {
    (async () => {
      if (!me.profile) {
        await api.ensureProfile().catch(() => {});
        const p = await loadProfile(me.id).catch(() => null);
        if (p) me.setProfile(p);
      }
      api.processRecurring().catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentGroup = path.startsWith("/groups/") ? path.split("/")[2] : null;
  const openQuick = useCallback(
    (gid?: string | null) => {
      if (!groups.length) {
        toast.ok("Create a group first");
        router.push("/groups/new");
        return;
      }
      setQuick({ open: true, gid: gid ?? (currentGroup && currentGroup !== "new" ? currentGroup : null) });
    },
    [groups.length, currentGroup, router, toast],
  );

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const name = me.profile?.display_name || me.email || "You";
  const nav = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/activity", label: "Activity", icon: Activity },
    { href: "/account", label: "Account", icon: Settings },
  ];
  const active = (href: string) => path === href || path.startsWith(href + "/");

  return (
    <QuickAddContext.Provider value={{ open: openQuick, groups }}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <Link href="/dashboard" className="brand-link"><LogoMark size={24} /><span className="wordmark">SPLIT<b>TER</b></span></Link>
            <ThemeCycle />
          </div>
          <button type="button" className="btn btn-primary btn-block" onClick={() => openQuick()}>
            <Plus /> Add expense
          </button>
          <nav className="nav">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={active(n.href) ? "active" : ""}>
                <n.icon /> {n.label}
              </Link>
            ))}
          </nav>
          <div className="side-section">
            <div className="eyebrow">
              Groups
              <Link href="/groups/new" aria-label="New group" title="New group"><Plus width={14} height={14} /></Link>
            </div>
            {groups.map((g) => {
              const K = groupKind(g.kind).icon;
              return (
                <Link key={g.id} href={`/groups/${g.id}`} className={`side-link ${currentGroup === g.id ? "active" : ""}`}>
                  <K /> <span className="clamp-2">{g.name}</span>
                </Link>
              );
            })}
            {!groups.length && <Link href="/groups/new" className="side-link"><Users /> Create your first group</Link>}
          </div>
          <div className="side-foot">
            <Avatar name={name} src={me.profile?.avatar_url} size={32} />
            <div className="who">
              <div className="clamp-2" style={{ fontWeight: 500 }}>{name}</div>
              <div className="ellipsis tiny faint">{me.email}</div>
            </div>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={signOut} title="Sign out" aria-label="Sign out">
              <LogOut />
            </button>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <Link href="/dashboard" className="brand-link" style={{ gap: 8 }}><LogoMark size={22} /><span className="wordmark" style={{ fontSize: 19 }}>SPLIT<b>TER</b></span></Link>
            <span className="row-flex" style={{ gap: 6 }}><ThemeCycle /><Link href="/account" aria-label="Account"><Avatar name={name} src={me.profile?.avatar_url} size={30} /></Link></span>
          </header>
          {children}
        </div>

        <nav className="tabbar">
          <Link href="/dashboard" className={active("/dashboard") ? "active" : ""}><LayoutDashboard />Home</Link>
          <Link href="/groups" className={path === "/groups" || currentGroup ? "active" : ""}><Users />Groups</Link>
          <button type="button" className="tab-add" onClick={() => openQuick()} aria-label="Add expense"><span><Plus /></span></button>
          <Link href="/activity" className={active("/activity") ? "active" : ""}><Activity />Activity</Link>
          <Link href="/account" className={active("/account") ? "active" : ""}><Settings />Account</Link>
        </nav>
      </div>

      <ExpenseEditor
        open={quick.open}
        onClose={() => setQuick({ open: false, gid: null })}
        groups={groups}
        initialGroupId={quick.gid}
        onSaved={(_, gid) => {
          if (currentGroup !== gid) router.push(`/groups/${gid}`);
        }}
      />
    </QuickAddContext.Provider>
  );
}
