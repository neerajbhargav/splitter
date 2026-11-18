import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { ToastProvider } from "@/components/providers";
import "./globals.css";
import { THEME_BOOT, THEME_COLORS } from "@/lib/theme";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif" });
const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

const DESCRIPTION = "Split rent and bills to the cent, by the days each person lived there, and settle in the fewest payments. Plus a private view of your own money. Free, open source, no ads.";

export const metadata: Metadata = {
  // Absolute URLs for the share card. A self-hosted copy sets NEXT_PUBLIC_SITE_URL to its own address.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://usesplitter.vercel.app"),
  title: { default: "SPLITTER", template: "%s · SPLITTER" },
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "SPLITTER", title: "SPLITTER: split rent to the cent", description: DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: "SPLITTER: split rent to the cent", description: DESCRIPTION },
  applicationName: "SPLITTER",
  appleWebApp: { capable: true, title: "SPLITTER", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
