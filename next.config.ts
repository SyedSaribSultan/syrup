import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/ESM packages the server uses directly; keep them out of the bundler.
  serverExternalPackages: ["@opencode-ai/sdk", "@libsql/client", "cross-spawn", "@modelcontextprotocol/sdk"],
};

export default nextConfig;
