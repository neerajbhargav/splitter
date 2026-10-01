export function SetupNotice() {
  return (
    <main className="page page-narrow" style={{ paddingTop: "calc(80px + env(safe-area-inset-top))" }}>
      <div className="wordmark">SPLIT<b>TER</b></div>
      <h1 className="page-title" style={{ marginTop: 28 }}>Almost there.</h1>
      <p className="page-sub">
        SPLITTER needs a Supabase project to store groups and handle sign-in. Add these two environment variables
        (locally in <code>.env.local</code>, or in Vercel under Settings, Environment Variables), then redeploy.
      </p>
      <div className="card" style={{ marginTop: 22 }}>
        <div className="card-body">
          <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--ink-2)" }}>
{`NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon or publishable key>`}
          </pre>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 14 }}>
        Full steps, including running <code>supabase/schema.sql</code> and turning on Google and GitHub sign-in, are in the README.
      </p>
    </main>
  );
}
