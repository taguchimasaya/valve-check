import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { can, deniedMessage, parseRoles, type Permission, type Role } from "./roles";

// API 側のログイン確認。端末から送られたトークンを Supabase で確かめ、
// その利用者として DB に接続するクライアント（RLS で authenticated として扱われる）と、利用者の権限を返す。

export type AuthContext = {
  client: SupabaseClient;
  userId: string;
  name: string;
  loginId: string;
  roles: Role[];
  /** 環境変数 ADMIN_LOGIN_IDS で管理者に指定された利用者 */
  envAdmin: boolean;
};

/** ログイン ID：メールアドレスの @ より前 */
export const loginIdOf = (email: string | null | undefined) => (email ?? "").split("@")[0].toLowerCase();

/** 環境変数 ADMIN_LOGIN_IDS（カンマ区切りのログイン ID）。最初の管理者を決めるために使う */
export function envAdminIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_LOGIN_IDS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * 利用者の権限：app_metadata.roles。未設定の利用者は作業者として扱う。
 * ADMIN_LOGIN_IDS に書かれた利用者は、保存値にかかわらず管理者（管理者が誰もいなくなるのを防ぐ）。
 */
export function rolesOf(user: Pick<User, "email" | "app_metadata">): { roles: Role[]; envAdmin: boolean; stored: Role[] | null } {
  const stored = parseRoles(user.app_metadata?.roles);
  const envAdmin = envAdminIds().has(loginIdOf(user.email));
  const roles = [...(stored ?? ["worker"])] as Role[];
  if (envAdmin && !roles.includes("admin")) roles.push("admin");
  return { roles, envAdmin, stored };
}

/** 無効化（Supabase Auth の利用停止 banned_until）中か */
export const isDisabled = (user: Pick<User, "banned_until">) =>
  !!user.banned_until && Date.parse(user.banned_until) > Date.now();

export const displayNameOf = (user: Pick<User, "email" | "user_metadata">) => {
  const meta = user.user_metadata as { name?: string; display_name?: string } | undefined;
  return meta?.name || meta?.display_name || loginIdOf(user.email);
};

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
  // getUser は Supabase Auth に問い合わせるため、権限の変更・無効化はすぐに反映される
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return Response.json({ error: "ログインの有効期限が切れました。もう一度ログインしてください" }, { status: 401 });
  if (isDisabled(data.user)) return Response.json({ error: "この利用者は無効になっています。管理者に連絡してください" }, { status: 401 });
  const { roles, envAdmin } = rolesOf(data.user);
  return { client, userId: data.user.id, name: displayNameOf(data.user), loginId: loginIdOf(data.user.email), roles, envAdmin };
}

/** ログインに加えて、いずれかの権限を持っているかを確かめる。足りなければ 403 */
export async function requirePerm(request: Request, ...perms: Permission[]): Promise<AuthContext | Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  if (!can(auth.roles, ...perms)) return forbidden(perms);
  return auth;
}

export const forbidden = (perms: Permission[]) => Response.json({ error: deniedMessage(perms) }, { status: 403 });

/** service role キーで接続するクライアント（利用者の作成・権限変更に使う。サーバー側だけで使うこと） */
export function adminClient(): SupabaseClient | Response {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return Response.json(
      { error: "サーバーに SUPABASE_SERVICE_ROLE_KEY が設定されていません（.env.local または Vercel の環境変数に追加してください）" },
      { status: 500 }
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
