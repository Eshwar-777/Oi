/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@oi/shared-types", "@oi/api-client", "@oi/theme"],
  async rewrites() {
    const backendPort = process.env.OI_BACKEND_PORT || process.env.BACKEND_PORT || "8080";
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${backendPort}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
