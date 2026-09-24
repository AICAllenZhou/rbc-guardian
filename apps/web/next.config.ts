import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@guardian/shared", "@guardian/alebex-protocol"],
  poweredByHeader: false,
  reactStrictMode: true,
  // Only this one non-secret value reaches the browser. The Alebex token never does.
  env: { NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3001" },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
