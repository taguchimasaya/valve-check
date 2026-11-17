import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import {
  can,
  deniedMessage,
  parseGrants,
  parseRoles,
  parseSiteRoles,
  rolesAt,
  setGrants,
  siteAccess,
  type Grants,
  type Permission,
  type Role,
  type SiteRoles,
} from "./roles";

// ───── 権限×機能の表（全拠点共通）─────
// DB の app_settings（key = role_grants）に保存する。テーブルが無い（SQL 未実行）・未設定なら既定の表。
// 変更はすぐ効くよう短い時間だけ覚えておく（保存した API ではすぐ読み直す）。

export const GRANTS_KEY = "role_grants";
const GRANTS_TTL_MS = 15_000;
let grantsCache: { at: number; grants: Grants | null; stored: boolean; tableMissing: boolean } | null = null;

/** 権限×機能の表を読み込んで、この後の権限の判定に使う */
export async function loadGrants(client: SupabaseClient, force = false) {
  if (!force && grantsCache && Date.now() - grantsCache.at < GRANTS_TTL_MS) {
    setGrants(grantsCache.grants);
    return grantsCache;
  }
  const { data, error } = await client.from("app_settings").select("value").eq("key", GRANTS_KEY).maybeSingle();
  const tableMissing = !!error && (error.code === "42P01" || error.code === "PGRST205");
  // 読めなかったとき（一時的なエラー）は、覚えている表があればそれを使い続ける
  if (error && !tableMissing && grantsCache) {
    setGrants(grantsCache.grants);
    return grantsCache;
  }
  const grants = data ? parseGrants(data.value) : null;
  grantsCache = { at: Date.now(), grants, stored: !!grants, tableMissing };
  setGrants(grants);
  return grantsCache;
}

// API 側のログイン確認。端末から送られたトークンを Supabase で確かめ、
// その利用者として DB に接続するクライアント（RLS で authenticated として扱われる）と、利用者の権限を返す。

export type AuthContext = {
  client: SupabaseClient;
  userId: string;
  name: string;
  loginId: string;
  /** 全拠点を合わせた権限（拠点の区別が無い画面・API 用）。拠点ごとの判断は rolesAtSite() を使う */
  roles: Role[];
  /** 拠点ごとの権限（未設定なら null：roles がすべての拠点に効く） */
  siteRoles: SiteRoles | null;
  /** 環境変数 ADMIN_LOGIN_IDS で管理者に指定された利用者 */
  envAdmin: boolean;
};

/** ある拠点での権限 */
export const rolesAtSite = (auth: Pick<AuthContext, "roles" | "siteRoles">, facility: string) => rolesAt(auth, facility);

/** 拠点を見られるか（none なら 403 を返す）。view は表示だけ（どこかの拠点で制御室の人） */
export function requireSite(auth: Pick<AuthContext, "roles" | "siteRoles">, facility: string): "full" | "view" | Response {
  const a = siteAccess(auth, facility);
  return a === "none" ? Response.json({ error: "この拠点を見る権限がありません" }, { status: 403 }) : a;
}

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
 * 利用者の権限：app_metadata.roles。未設定の利用者は権限なし（何もできない）として扱う。
 * （以前は作業者として扱っていたが、Supabase の新規登録で作られたアカウントが作業者になってしまうため変更した）
 * ADMIN_LOGIN_IDS に書かれた利用者は、保存値にかかわらず管理者（管理者が誰もいなくなるのを防ぐ）。
 */
export function rolesOf(user: Pick<User, "email" | "app_metadata">): {
  roles: Role[];
  siteRoles: SiteRoles | null;
  envAdmin: boolean;
  stored: Role[] | null;
} {
  const stored = parseRoles(user.app_metadata?.roles);
  const siteRoles = parseSiteRoles(user.app_metadata?.siteRoles);
  const envAdmin = envAdminIds().has(loginIdOf(user.email));
  const roles = [...(stored ?? [])] as Role[];
  if (envAdmin && !roles.includes("admin")) roles.push("admin");
  return { roles, siteRoles, envAdmin, stored };
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
  const { roles, siteRoles, envAdmin } = rolesOf(data.user);
  await loadGrants(client);
  return { client, userId: data.user.id, name: displayNameOf(data.user), loginId: loginIdOf(data.user.email), roles, siteRoles, envAdmin };
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
