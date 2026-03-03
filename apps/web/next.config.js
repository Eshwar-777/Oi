/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@oi/shared-types", "@oi/api-client", "@oi/theme"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8080/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
