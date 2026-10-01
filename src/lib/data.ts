"use client";
import { useEffect, useRef } from "react";
import { supabaseBrowser } from "./supabase/client";
import type { ActivityItem, Comment, Expense, ExpenseInput, Group, Invite, Member, Profile, UpcomingBill, UpcomingInput } from "./types";

const sb = () => supabaseBrowser();

type PgResult<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(res: PgResult<T>): T {
  if (res.error) throw new Error(friendly(res.error.message));
  return res.data as T;
}

export function friendly(msg: string): string {
  if (/JWT|not signed in|Auth session missing/i.test(msg)) return "Your session expired. Sign in again.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return "You look offline. Check your connection and try again.";
  return msg.replace(/^ERROR:\s*/, "");
}

/** PostgREST caps responses at 1000 rows, so page through. */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<PgResult<T[]>>): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const rows = unwrap(await page(from, from + size - 1)) ?? [];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

const EXPENSE_COLS = "*, expense_payers(member_id, amount_cents), expense_splits(member_id, amount_cents, weight)";

const CHANGED = "splitter:changed";

/** Tell every open view on this device to refetch right away (realtime covers other devices). */
export function notifyChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

export type GroupBundle = { group: Group; members: Member[]; expenses: Expense[]; activity: ActivityItem[]; profiles: Profile[]; upcoming: UpcomingBill[] };

export async function loadGroup(gid: string): Promise<GroupBundle | null> {
  const [g, members, expenses, activity, profiles, upcoming] = await Promise.all([
    sb().from("groups").select("*").eq("id", gid).maybeSingle(),
    sb().from("group_members").select("*").eq("group_id", gid).order("created_at"),
    fetchAll<Expense>((a, b) =>
      sb().from("expenses").select(EXPENSE_COLS).eq("group_id", gid)
        .order("expense_date", { ascending: false }).order("created_at", { ascending: false }).range(a, b)),
    sb().from("activity").select("*").eq("group_id", gid).order("created_at", { ascending: false }).limit(150),
    sb().from("profiles").select("*"),
    sb().from("upcoming_bills").select("*, upcoming_bill_shares(member_id, amount_cents, paid_at, paid_marked_by)").eq("group_id", gid).eq("status", "upcoming")
      .order("due_date", { ascending: true, nullsFirst: false }),
  ]);
  const group = unwrap(g as PgResult<Group>);
  if (!group) return null;
  return {
    group,
    members: unwrap(members as PgResult<Member[]>) ?? [],
    expenses,
    activity: unwrap(activity as PgResult<ActivityItem[]>) ?? [],
    profiles: unwrap(profiles as PgResult<Profile[]>) ?? [],
    // Older deployments may not have run the upcoming-bills migration yet: treat as none.
    upcoming: upcoming.error ? [] : ((upcoming.data as UpcomingBill[]) ?? []),
  };
}

export type Overview = { groups: Group[]; members: Member[]; expenses: Expense[]; activity: ActivityItem[]; profiles: Profile[]; upcoming: UpcomingBill[] };

export async function loadOverview(activityLimit = 40): Promise<Overview> {
  const [groups, members, expenses, activity, profiles, upcoming] = await Promise.all([
    sb().from("groups").select("*").order("updated_at", { ascending: false }),
    sb().from("group_members").select("*").order("created_at"),
    fetchAll<Expense>((a, b) =>
      sb().from("expenses").select(EXPENSE_COLS).is("deleted_at", null)
        .order("expense_date", { ascending: false }).range(a, b)),
    sb().from("activity").select("*").order("created_at", { ascending: false }).limit(activityLimit),
    sb().from("profiles").select("*"),
    sb().from("upcoming_bills").select("*, upcoming_bill_shares(member_id, amount_cents, paid_at, paid_marked_by)").eq("status", "upcoming")
      .order("due_date", { ascending: true, nullsFirst: false }),
  ]);
  return {
    groups: unwrap(groups as PgResult<Group[]>) ?? [],
    members: unwrap(members as PgResult<Member[]>) ?? [],
    expenses,
    activity: unwrap(activity as PgResult<ActivityItem[]>) ?? [],
    profiles: unwrap(profiles as PgResult<Profile[]>) ?? [],
    upcoming: upcoming.error ? [] : ((upcoming.data as UpcomingBill[]) ?? []),
  };
}

export async function loadGroupsLite(): Promise<Group[]> {
  return unwrap((await sb().from("groups").select("*").order("name")) as PgResult<Group[]>) ?? [];
}

export async function loadComments(expenseId: string): Promise<Comment[]> {
  return unwrap((await sb().from("comments").select("*").eq("expense_id", expenseId).order("created_at")) as PgResult<Comment[]>) ?? [];
}

export async function addComment(expenseId: string, groupId: string, userId: string, body: string) {
  unwrap((await sb().from("comments").insert({ expense_id: expenseId, group_id: groupId, user_id: userId, body })) as PgResult<null>);
  notifyChanged();
}

export async function deleteComment(id: string) {
  unwrap((await sb().from("comments").delete().eq("id", id)) as PgResult<null>);
}

export async function loadProfile(id: string): Promise<Profile | null> {
  return unwrap((await sb().from("profiles").select("*").eq("id", id).maybeSingle()) as PgResult<Profile>);
}

async function call<T>(fn: string, args: Record<string, unknown>, mutates = true): Promise<T> {
  const out = unwrap((await sb().rpc(fn, args)) as PgResult<T>);
  if (mutates) notifyChanged();
  return out;
}

export const api = {
  ensureProfile: () => call<null>("ensure_profile", {}, false),
  updateProfile: (name: string, currency: string) => call<null>("update_profile", { p_name: name, p_currency: currency }),
  createGroup: (name: string, kind: string, currency: string, members: { name: string; email?: string; phone?: string }[]) =>
    call<string>("create_group", { p_name: name, p_kind: kind, p_currency: currency, p_members: members }),
  updateGroup: (gid: string, patch: { name?: string; kind?: string; currency?: string; simplify?: boolean }) =>
    call<null>("update_group", {
      gid, p_name: patch.name ?? null, p_kind: patch.kind ?? null, p_currency: patch.currency ?? null, p_simplify: patch.simplify ?? null,
    }),
  deleteGroup: (gid: string) => call<null>("delete_group", { gid }),
  leaveGroup: (gid: string) => call<null>("leave_group", { gid }),
  regenerateInvite: (gid: string) => call<string>("regenerate_invite", { gid }),
  getInvite: (code: string) => call<Invite | null>("get_invite", { p_code: code }, false),
  joinGroup: (code: string, claim: string | null, asNew = false) =>
    call<string>("join_group", { p_code: code, p_claim: claim, p_new: asNew }),
  unclaimMySpot: (gid: string) => call<string>("unclaim_my_spot", { gid }),
  addMember: (gid: string, name: string, email?: string, phone?: string) =>
    call<string>("add_member", { gid, p_name: name, p_email: email || null, p_phone: phone || null }),
  updateMember: (mid: string, name: string, email?: string | null, phone?: string | null) =>
    call<null>("update_member", { mid, p_name: name, p_email: email || null, p_phone: phone || null }),
  removeMember: (mid: string) => call<null>("remove_member", { mid }),
  saveExpense: (id: string | null, gid: string, input: ExpenseInput) => call<string>("save_expense", { p_id: id, p_group: gid, p: input }),
  deleteExpense: (id: string) => call<null>("delete_expense", { eid: id }),
  restoreExpense: (id: string) => call<null>("restore_expense", { eid: id }),
  saveUpcoming: (id: string | null, gid: string, input: UpcomingInput) =>
    call<string>("save_upcoming_bill", { p_id: id, p_group: gid, p: input }),
  deleteUpcoming: (id: string) => call<null>("delete_upcoming_bill", { bid: id }),
  setSharePaid: (bid: string, mid: string, paid: boolean) => call<null>("set_share_paid", { bid, mid, p_paid: paid }),
  markUpcomingPaid: (id: string, payers: { member_id: string; amount_cents: number }[], date: string) =>
    call<string>("mark_upcoming_paid", { bid: id, p_payers: payers, p_date: date }),
  processRecurring: async () => {
    const n = await call<number>("process_recurring", {}, false);
    if (n > 0) notifyChanged();
    return n;
  },
};

export async function uploadReceipt(groupId: string, file: File): Promise<string> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
  const path = `${groupId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb().storage.from("receipts").upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error(friendly(error.message));
  return path;
}

export async function receiptUrl(path: string): Promise<string | null> {
  const { data } = await sb().storage.from("receipts").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

type Sub = { table: string; filter?: string };

/**
 * Live sync: refetch when any watched table changes, when the tab becomes
 * visible again, or when the device comes back online.
 */
export function useLiveRefresh(key: string, subs: Sub[], onChange: () => void, enabled = true) {
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });
  const subsKey = JSON.stringify(subs);
  useEffect(() => {
    if (!enabled) return;
    const client = sb();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cb.current(), 200);
    };
    const list: Sub[] = JSON.parse(subsKey);
    const channel = client.channel(`${key}:${Math.random().toString(36).slice(2, 8)}`);
    for (const s of list) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: s.table, ...(s.filter ? { filter: s.filter } : {}) },
        fire,
      );
    }
    channel.subscribe();
    const onVisible = () => {
      if (document.visibilityState === "visible") fire();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", fire);
    window.addEventListener(CHANGED, fire);
    return () => {
      window.removeEventListener(CHANGED, fire);
      clearTimeout(timer);
      client.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", fire);
    };
  }, [key, subsKey, enabled]);
}
