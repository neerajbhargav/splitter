"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, ChartPie, LogOut, Plus, Search, Split, Users, Wallet } from "lucide-react";
import { MeProvider, useMe, useToast } from "./providers";
import { Avatar, LogoMark, Modal } from "./ui";
import { MONEY_SECTIONS, sectionActive } from "./finance/sections";
import { isSplitPath } from "./SplitNav";
import { ThemeCycle } from "./ThemeToggle";
import { ExpenseEditor } from "./ExpenseEditor";
import { api, loadGroupsLite, loadProfile, useLiveRefresh } from "@/lib/data";
import { supabaseBrowser } from "@/lib/supabase/client";
import { groupKind } from "@/lib/categories";
import type { Group, Profile } from "@/lib/types";

type Prefill = { description?: string; amount_cents?: number };
type QuickAdd = { open: (groupId?: string | null, prefill?: Prefill) => void; groups: Group[] };
const QuickAddContext = createContext<QuickAdd>({ open: () => {}, groups: [] });
export const useQuickAdd = () => useContext(QuickAddContext);
/** Finance pages listen for this to open "add a transaction" in place. */
export const ADD_TRANSACTION_EVENT = "splitter:add-transaction";

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
  const [quick, setQuick] = useState<{ open: boolean; gid: string | null; prefill?: Prefill }>({ open: false, gid: null });
  const [choosing, setChoosing] = useState(false);

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
    (gid?: string | null, prefill?: Prefill) => {
      if (!groups.length) {
        toast.ok("Create a group first");
        router.push("/groups/new");
        return;
      }
      setQuick({ open: true, gid: gid ?? (currentGroup && currentGroup !== "new" ? currentGroup : null), prefill });
    },
    [groups.length, currentGroup, router, toast],
  );

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const name = me.profile?.display_name || me.email || "You";
  const active = (href: string) => path === href || path.startsWith(href + "/");
  const inSplit = isSplitPath(path);

  /** "+" asks what you're adding: your own spending, or a cost shared with a group. */
  function addMoney() {
    setChoosing(false);
    if (path.startsWith("/finance")) window.dispatchEvent(new Event(ADD_TRANSACTION_EVENT));
    else router.push("/finance/activity?add=1");
  }

  return (
    <QuickAddContext.Provider value={{ open: openQuick, groups }}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <Link href="/finance" className="brand-link"><LogoMark size={24} /><span className="wordmark">SPLIT<b>TER</b></span></Link>
            <ThemeCycle />
          </div>
          <button type="button" className="btn btn-primary btn-block" onClick={() => setChoosing(true)}>
            <Plus /> Add
          </button>
          <nav className="nav" aria-label="Your money">
            {MONEY_SECTIONS.map((n) => (
              <Link key={n.href} href={n.href} className={sectionActive(path, n.href) ? "active" : ""} aria-current={sectionActive(path, n.href) ? "page" : undefined}>
                <n.icon /> {n.label}
              </Link>
            ))}
          </nav>
          <nav className="nav nav-split" aria-label="Split with others">
            <Link href="/dashboard" className={inSplit && !currentGroup ? "active" : ""} aria-current={inSplit && !currentGroup ? "page" : undefined}><Split /> Split</Link>
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
            <Link href="/account" className={`side-account ${active("/account") ? "active" : ""}`} title="Account">
              <Avatar name={name} src={me.profile?.avatar_url} size={32} />
              <div className="who">
                <div className="clamp-2" style={{ fontWeight: 500 }}>{name}</div>
                <div className="ellipsis tiny faint">Account</div>
              </div>
            </Link>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={signOut} title="Sign out" aria-label="Sign out">
              <LogOut />
            </button>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <Link href="/finance" className="brand-link" style={{ gap: 8 }}><LogoMark size={22} /><span className="wordmark" style={{ fontSize: 19 }}>SPLIT<b>TER</b></span></Link>
            <span className="row-flex" style={{ gap: 6 }}>
              <Link href="/search" className="btn btn-ghost btn-icon btn-sm" aria-label="Search all groups" title="Search all groups"
                aria-current={active("/search") ? "page" : undefined} style={active("/search") ? { color: "var(--gold-text)" } : undefined}><Search /></Link>
              <ThemeCycle /><Link href="/account" aria-label="Account"><Avatar name={name} src={me.profile?.avatar_url} size={30} /></Link>
            </span>
          </header>
          {children}
        </div>

        <nav className="tabbar" aria-label="Main">
          <Link href="/finance" className={path.startsWith("/finance") && !active("/finance/activity") && !active("/finance/budget") ? "active" : ""}><Wallet />Money</Link>
          <Link href="/finance/activity" className={active("/finance/activity") ? "active" : ""}><ArrowLeftRight />Activity</Link>
          <button type="button" className="tab-add" onClick={() => setChoosing(true)} aria-label="Add"><span><Plus /></span></button>
          <Link href="/finance/budget" className={active("/finance/budget") ? "active" : ""}><ChartPie />Budget</Link>
          <Link href="/dashboard" className={inSplit ? "active" : ""}><Split />Split</Link>
        </nav>
      </div>

      <Modal open={choosing} onClose={() => setChoosing(false)} title="Add">
        <div className="list">
          <button type="button" className="item clickable" onClick={addMoney}>
            <span className="icon-tile"><Wallet /></span>
            <div className="item-main"><div className="item-title">Spending or income</div><div className="item-sub">Goes into your own money. Only you see it.</div></div>
          </button>
          <button type="button" className="item clickable" onClick={() => { setChoosing(false); openQuick(); }}>
            <span className="icon-tile"><Users /></span>
            <div className="item-main"><div className="item-title">Split with a group</div><div className="item-sub">A cost shared with roommates, a trip or friends.</div></div>
          </button>
        </div>
      </Modal>

      <ExpenseEditor
        open={quick.open}
        onClose={() => setQuick({ open: false, gid: null })}
        groups={groups}
        initialGroupId={quick.gid}
        prefill={quick.prefill}
        onSaved={(_, gid) => {
          if (currentGroup !== gid) router.push(`/groups/${gid}`);
        }}
      />
    </QuickAddContext.Provider>
  );
}
