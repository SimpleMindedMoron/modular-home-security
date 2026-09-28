/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    const aiProcessorUrl = process.env.AI_PROCESSOR_URL || 'http://127.0.0.1:8765';
    return [
      {
        source: '/recordings/:path*',
        destination: `${aiProcessorUrl}/recordings/:path*`,
      },
      {
        source: '/snapshots/:path*',
        destination: `${aiProcessorUrl}/snapshots/:path*`,
      },
    ];
  },
};

export default nextConfig;
