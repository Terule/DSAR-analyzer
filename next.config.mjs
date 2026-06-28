/** @type {import('next').NextConfig} */
const nextConfig = {
  // Tells Next.js Webpack to leave these backend packages entirely alone
  serverExternalPackages: ["pdf-parse", "mammoth", "xlsx", "mailparser"],
};

export default nextConfig;
