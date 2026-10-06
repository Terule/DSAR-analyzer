import { withDataDirsIgnored } from "./next-watch-ignore.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Tells Next.js Webpack to leave these backend packages entirely alone
  serverExternalPackages: ["pdf-parse", "mammoth", "xlsx", "mailparser"],
  webpack: (config, { dev }) => {
    // Worker output in logs/ and batches/ must not hot-reload the dashboard.
    if (dev) {
      config.watchOptions = withDataDirsIgnored(
        config.watchOptions,
        process.cwd(),
        ["logs", "batches"],
      );
    }
    return config;
  },
};

export default nextConfig;
