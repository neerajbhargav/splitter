import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";
import { SetupNotice } from "@/components/SetupNotice";
import { hasSupabaseEnv } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  if (!hasSupabaseEnv) return <SetupNotice />;
  const sp = await searchParams;
  const next = sp.next && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/dashboard";
  return (
    <main className="auth-panel">
      <LoginForm next={next} initialError={sp.error ?? null} joining={next.startsWith("/join/")} />
    </main>
  );
}
