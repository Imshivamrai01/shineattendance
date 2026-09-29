/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['mongoose', 'bcryptjs'],
  poweredByHeader: false,
  devIndicators: false, // hides the floating dev badge that overlapped the mobile bottom bar
};
export default nextConfig;
