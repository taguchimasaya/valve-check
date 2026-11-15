import { adminClient, requireAuth, rolesOf } from "@/lib/serverAuth";

// ログイン中の利用者の名前と権限（画面のメニューの表示・ページの入口の判定に使う）。
// ADMIN_LOGIN_IDS で管理者に指定された利用者は、app_metadata.roles にも管理者を書き込む
// （DB 側の権限チェック supabase/auth_roles_rls.sql はトークンの app_metadata を見るため）。

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  if (auth.envAdmin) {
    const admin = adminClient();
    if (!(admin instanceof Response)) {
      const { data } = await admin.auth.admin.getUserById(auth.userId);
      if (data.user) {
        const { stored } = rolesOf(data.user);
        if (!stored?.includes("admin")) {
          await admin.auth.admin.updateUserById(auth.userId, {
            app_metadata: { roles: [...(stored ?? []), "admin"] },
          });
        }
      }
    }
  }
  return Response.json({
    userId: auth.userId,
    name: auth.name,
    loginId: auth.loginId,
    roles: auth.roles,
    siteRoles: auth.siteRoles,
    envAdmin: auth.envAdmin,
  });
}
