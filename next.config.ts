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
  // No remotePatterns: nothing uses next/image, so the optimizer must not fetch other hosts.
  // Receipts and avatars are plain <img> tags.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
