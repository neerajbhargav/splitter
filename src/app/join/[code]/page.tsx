"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Avatar, Loading, Spinner, LogoMark } from "@/components/ui";
import { useToast } from "@/components/providers";
import { api } from "@/lib/data";
import { supabaseBrowser } from "@/lib/supabase/client";
import { groupKind } from "@/lib/categories";
import type { Invite } from "@/lib/types";

export default function JoinPage() {
  return (
    <Suspense fallback={<Loading label="Opening invite" />}>
      <Join />
    </Suspense>
  );
}

function Join() {
  const { code } = useParams<{ code: string }>();
  const search = useSearchParams();
  const forcePick = search.get("pick") === "1";
  const router = useRouter();
  const toast = useToast();
  const [invite, setInvite] = useState<Invite | null | undefined>(undefined);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [claim, setClaim] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState<string | null>(null);
  const tried = useRef(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabaseBrowser().auth.getUser();
      setSignedIn(!!data.user);
      try {
        setInvite(await api.getInvite(code));
      } catch {
        setInvite(null);
      }
    })();
  }, [code]);

  async function join(spot: string | null, asNew = false, label?: string) {
    setBusy(true);
    try {
      const gid = await api.joinGroup(code, spot, asNew);
      toast.ok(label ? `You joined ${invite?.name ?? "the group"} as ${label}` : `You're in ${invite?.name ?? "the group"}`);
      router.replace(`/groups/${gid}`);
    } catch (e) {
      toast.err(e);
      setBusy(false);
      setAuto(null);
    }
  }

  // Clear match (same email, or a single spot with your name): join automatically, no questions.
  useEffect(() => {
    if (!invite || !signedIn || invite.already_member || forcePick || tried.current) return;
    tried.current = true;
    const s = invite.suggested;
    if (s) {
      const spot = invite.placeholders.find((p) => p.id === s.member_id);
      setAuto(spot?.display_name ?? "your name");
      join(s.member_id, false, spot?.display_name);
    } else if (!invite.placeholders.length) {
      setAuto(invite.me_name ?? "you");
      join(null, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite, signedIn, forcePick]);

  if (invite === undefined || signedIn === null) return <Loading label="Opening invite" />;
  if (auto) return <Loading label={`Joining as ${auto}`} />;

  const K = invite ? groupKind(invite.kind).icon : null;
  const picked = invite?.placeholders.find((p) => p.id === claim);

  function confirmAndJoin() {
    if (!invite) return;
    if (claim === "new") return join(null, true);
    if (!picked) return;
    if (!picked.looks_like_me) {
      const ok = confirm(
        `You're signed in as ${invite.me_name ?? "someone else"}, but you picked "${picked.display_name}".\n\n` +
          `Their expenses and balance will become yours. Only continue if you really are ${picked.display_name}.`,
      );
      if (!ok) return;
    }
    join(picked.id, false, picked.display_name);
  }

  return (
    <main className="page page-narrow" style={{ paddingTop: "calc(72px + env(safe-area-inset-top))" }}>
      <Link href="/" className="brand-link"><LogoMark size={26} /><span className="wordmark">SPLIT<b>TER</b></span></Link>
      {!invite ? (
        <div style={{ marginTop: 40 }}>
          <h1 className="page-title">This invite expired.</h1>
          <p className="page-sub">The link was reset or the group was deleted. Ask a member for a fresh link.</p>
          <Link href="/dashboard" className="btn" style={{ marginTop: 18 }}>Go to dashboard</Link>
        </div>
      ) : (
        <div style={{ marginTop: 40 }}>
          <div className="eyebrow row-flex">{K && <K width={13} height={13} />} You are invited to</div>
          <h1 className="page-title">{invite.name}</h1>
          <p className="page-sub">{invite.member_count} {invite.member_count === 1 ? "person" : "people"} already splitting expenses here.</p>

          {invite.already_member ? (
            <Link href={`/groups/${invite.group_id}`} className="btn btn-primary btn-lg" style={{ marginTop: 22 }}>Open group</Link>
          ) : !signedIn ? (
            <>
              <Link href={`/login?next=${encodeURIComponent(`/join/${code}`)}`} className="btn btn-primary btn-lg" style={{ marginTop: 22 }}>
                Sign in to join
              </Link>
              <p className="hint" style={{ marginTop: 12 }}>We'll match you to your name automatically after you sign in.</p>
            </>
          ) : (
            <div className="card" style={{ marginTop: 24 }}>
              <div className="card-body stack">
                <div>
                  <div style={{ fontWeight: 500 }}>Which one is you{invite.me_name ? `, ${invite.me_name.split(" ")[0]}` : ""}?</div>
                  <div className="hint">We couldn't match your name or email to one spot, so pick yours. Claiming a spot keeps the expenses already logged for that person.</div>
                </div>
                <div className="list">
                  {invite.placeholders.map((p) => (
                    <label key={p.id} className="item" style={{ cursor: "pointer" }}>
                      <input type="radio" name="claim" checked={claim === p.id} onChange={() => setClaim(p.id)} style={{ accentColor: "var(--gold)" }} />
                      <Avatar name={p.display_name} color={p.color} size={28} />
                      <span className="item-main item-title">I am {p.display_name}</span>
                      {p.looks_like_me && <span className="badge gold">likely you</span>}
                    </label>
                  ))}
                  <label className="item" style={{ cursor: "pointer" }}>
                    <input type="radio" name="claim" checked={claim === "new"} onChange={() => setClaim("new")} style={{ accentColor: "var(--gold)" }} />
                    <span className="item-main item-title">I'm not listed, add me as someone new</span>
                  </label>
                </div>
                <button type="button" className="btn btn-primary btn-lg btn-block" onClick={confirmAndJoin} disabled={busy || !claim}>
                  {busy ? <Spinner /> : null} {picked ? `Join as ${picked.display_name}` : `Join ${invite.name}`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
