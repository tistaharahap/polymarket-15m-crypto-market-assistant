import type { NextConfig } from "next";

const nextConfig = {
  reactStrictMode: true,
  // All external network calls should happen server-side (Route Handlers).
} satisfies NextConfig;

export default nextConfig;
