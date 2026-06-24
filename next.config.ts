import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  serverExternalPackages: ["puppeteer", "puppeteer-core", "pdf-parse"],
};

export default nextConfig;
