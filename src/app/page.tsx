import { redirect } from "next/navigation";

// No landing page: the app opens straight to your dashboard (or sign-in).
export default function Home() {
  redirect("/dashboard");
}
