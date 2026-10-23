import type { NextConfig } from "next";

// Headers that cannot break a page. A script/style CSP is left out on purpose:
// Next's inline scripts would need nonces first.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera stays at its default (this site only): the receipt "Attach a photo" button can open the phone camera.
  // Nothing in src/ uses the microphone, location, payments or USB.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" },
  // Nothing frames the app, and src/ has no <base>, <object> or <embed>.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Nothing uses next/image (receipts and avatars are plain <img> tags), so the optimizer is turned off:
  // /_next/image had a remote code execution advisory up to 16.4.0 (GHSA-2464-fhr4-w9xw).
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
