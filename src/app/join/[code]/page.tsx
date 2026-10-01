"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, Loading, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { api } from "@/lib/data";
import { supabaseBrowser } from "@/lib/supabase/client";
import { groupKind } from "@/lib/categories";
import type { Invite } from "@/lib/types";

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const toast = useToast();
  const [invite, setInvite] = useState<Invite | null | undefined>(undefined);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [claim, setClaim] = useState<string>("new");
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    if (invite?.placeholders.length) setClaim(invite.placeholders[0].id);
  }, [invite]);

  async function join() {
    setBusy(true);
    try {
      const gid = await api.joinGroup(code, claim === "new" ? null : claim);
      toast.ok(`You're in ${invite?.name ?? "the group"}`);
      router.replace(`/groups/${gid}`);
    } catch (e) {
      toast.err(e);
      setBusy(false);
    }
  }

  if (invite === undefined || signedIn === null) return <Loading label="Opening invite" />;

  const K = invite ? groupKind(invite.kind).icon : null;
  return (
    <main className="page page-narrow" style={{ paddingTop: "calc(72px + env(safe-area-inset-top))" }}>
      <Link href="/" className="wordmark">SPLIT<b>TER</b></Link>
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
            <Link href={`/login?next=${encodeURIComponent(`/join/${code}`)}`} className="btn btn-primary btn-lg" style={{ marginTop: 22 }}>
              Sign in to join
            </Link>
          ) : (
            <div className="card" style={{ marginTop: 24 }}>
              <div className="card-body stack">
                {invite.placeholders.length > 0 && (
                  <>
                    <div>
                      <div style={{ fontWeight: 500 }}>Which one is you?</div>
                      <div className="hint">Your roommates may have already added you by name. Claim it to keep the expenses they logged for you.</div>
                    </div>
                    <div className="list">
                      {invite.placeholders.map((p) => (
                        <label key={p.id} className="item" style={{ cursor: "pointer" }}>
                          <input type="radio" name="claim" checked={claim === p.id} onChange={() => setClaim(p.id)} style={{ accentColor: "var(--gold)" }} />
                          <Avatar name={p.display_name} color={p.color} size={28} />
                          <span className="item-main item-title">I am {p.display_name}</span>
                        </label>
                      ))}
                      <label className="item" style={{ cursor: "pointer" }}>
                        <input type="radio" name="claim" checked={claim === "new"} onChange={() => setClaim("new")} style={{ accentColor: "var(--gold)" }} />
                        <span className="item-main item-title">I am not listed, add me as someone new</span>
                      </label>
                    </div>
                  </>
                )}
                <button type="button" className="btn btn-primary btn-lg btn-block" onClick={join} disabled={busy}>
                  {busy ? <Spinner /> : null} Join {invite.name}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
