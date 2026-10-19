import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 同じLAN内のスマホ・iPadから dev サーバー（このPC）で動作確認するため。開発時のみ有効で本番には影響しない
  allowedDevOrigins: ["192.168.0.21"],
};

export default nextConfig;
