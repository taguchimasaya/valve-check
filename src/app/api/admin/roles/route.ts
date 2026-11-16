import { GRANTS_KEY, loadGrants, requirePerm } from "@/lib/serverAuth";
import { DEFAULT_GRANTS, parseGrants } from "@/lib/roles";

// 権限×機能の表（全拠点共通）の読み書き。ユーザー管理・権限の設定の機能を持つ人だけ。
// 保存先は app_settings（key = role_grants）。書き込みはその利用者として行うので、DB 側の RLS（has_perm('users')）も効く。

const SQL_MISSING = "権限の設定の保存テーブル（app_settings）がありません。supabase/role_grants.sql を Supabase の SQL Editor で実行してください。";

export async function GET(request: Request) {
  const auth = await requirePerm(request, "users");
  if (auth instanceof Response) return auth;
  const g = await loadGrants(auth.client, true);
  return Response.json({ grants: g.grants ?? DEFAULT_GRANTS, defaults: DEFAULT_GRANTS, stored: g.stored, tableMissing: g.tableMissing });
}

export async function POST(request: Request) {
  const auth = await requirePerm(request, "users");
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => null)) as { grants?: unknown; reset?: boolean } | null;
  // 既定に戻す：保存した表を消す
  if (body?.reset) {
    const { error } = await auth.client.from("app_settings").delete().eq("key", GRANTS_KEY);
    if (error) return Response.json({ error: error.code === "42P01" || error.code === "PGRST205" ? SQL_MISSING : error.message }, { status: 500 });
  } else {
    const grants = parseGrants(body?.grants);
    if (!grants) return Response.json({ error: "権限×機能の表の形式が正しくありません" }, { status: 400 });
    const { error } = await auth.client
      .from("app_settings")
      .upsert({ key: GRANTS_KEY, value: grants, updated_at: new Date().toISOString(), updated_by: auth.name });
    if (error) {
      const missing = error.code === "42P01" || error.code === "PGRST205";
      return Response.json({ error: missing ? SQL_MISSING : `保存できませんでした：${error.message}` }, { status: missing ? 500 : 403 });
    }
  }
  const g = await loadGrants(auth.client, true);
  return Response.json({ grants: g.grants ?? DEFAULT_GRANTS, defaults: DEFAULT_GRANTS, stored: g.stored, tableMissing: g.tableMissing });
}
