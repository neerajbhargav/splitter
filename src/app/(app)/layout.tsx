import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { SetupNotice } from "@/components/SetupNotice";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { supabaseServer } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!hasSupabaseEnv) return <SetupNotice />;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
  return (
    <Shell user={{ id: data.user.id, email: data.user.email ?? null }} profile={(profile as Profile) ?? null}>
      {children}
    </Shell>
  );
}
