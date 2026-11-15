import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// API 側のログイン確認。端末から送られたトークンを Supabase で確かめ、
// その利用者として DB に接続するクライアント（RLS で authenticated として扱われる）を返す。

const LOGIN_DOMAIN = "valve-check.local";

export type AuthContext = { client: SupabaseClient; userId: string; name: string };

export async function requireAuth(request: Request): Promise<AuthContext | Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return Response.json({ error: "Supabaseの接続情報が設定されていません" }, { status: 500 });
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return Response.json({ error: "ログインしてください" }, { status: 401 });
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return Response.json({ error: "ログインの有効期限が切れました。もう一度ログインしてください" }, { status: 401 });
  const meta = data.user.user_metadata as { name?: string; display_name?: string } | undefined;
  const name = meta?.name || meta?.display_name || (data.user.email ?? "").replace(`@${LOGIN_DOMAIN}`, "");
  return { client, userId: data.user.id, name };
}
