import { redirect } from "next/navigation";

// No landing page: the app opens straight to your money (or sign-in).
export default function Home() {
  redirect("/finance");
}
