import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page page-narrow" style={{ paddingTop: "calc(90px + env(safe-area-inset-top))" }}>
      <Link href="/" className="wordmark">SPLIT<b>TER</b></Link>
      <h1 className="page-title" style={{ marginTop: 32 }}>Nothing here.</h1>
      <p className="page-sub">That page does not exist, or the link is out of date.</p>
      <Link href="/dashboard" className="btn" style={{ marginTop: 18 }}>Go to dashboard</Link>
    </main>
  );
}
