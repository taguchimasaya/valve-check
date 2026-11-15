import type { User } from "@supabase/supabase-js";
import { adminClient, displayNameOf, envAdminIds, isDisabled, loginIdOf, requirePerm, rolesOf } from "@/lib/serverAuth";
import { parseRoles, type Role } from "@/lib/roles";
import { mailMethod, notifyEmailOf, sendMails } from "@/lib/approvalMail";

// ユーザー管理 API（管理者のみ）。利用者の作成・権限変更・無効化は service role キーで Supabase Auth を操作する。
// GET                                        … 利用者の一覧
// POST {action:"create", loginId, name, password, roles} … 利用者を作成（メールの確認なしですぐ使える）
// POST {action:"update", id, name?, roles?, notifyEmail?} … 名前・権限・通知先メール（承認フローのメールの宛先）の変更
// POST {action:"password", id, password}     … パスワードの再設定
// POST {action:"disable" | "enable", id}     … 無効化（ログインできなくする）・有効に戻す
// POST {action:"testMail", id}               … 通知先メールにテストメールを送る（メールの設定の確認用）

const LOGIN_DOMAIN = "valve-check.local";
/** 無効化の期間（Supabase Auth の ban_duration。実質無期限） */
const BAN_FOREVER = "876000h";

export type AdminUser = {
  id: string;
  loginId: string;
  email: string;
  name: string;
  /** 承認フローのメールの宛先（ログイン用のアドレスとは別。空なら送らない） */
  notifyEmail: string;
  roles: Role[];
  /** 権限が未設定（作業者として扱っている） */
  rolesUnset: boolean;
  envAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
};

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

function toAdminUser(u: User): AdminUser {
  const { roles, envAdmin, stored } = rolesOf(u);
  return {
    id: u.id,
    loginId: loginIdOf(u.email),
    email: u.email ?? "",
    name: displayNameOf(u),
    notifyEmail: notifyEmailOf(u) ?? "",
    roles,
    rolesUnset: stored === null,
    envAdmin,
    disabled: isDisabled(u),
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at ?? null,
  };
}

type Admin = Exclude<ReturnType<typeof adminClient>, Response>;

async function listAll(admin: Admin): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}

/** 管理者として扱われる、有効な利用者が他にいるか（自分の管理者権限を外す・無効にする前の確認） */
function otherAdminExists(users: User[], selfId: string) {
  return users.some((u) => u.id !== selfId && !isDisabled(u) && rolesOf(u).roles.includes("admin"));
}

export async function GET(request: Request) {
  const auth = await requirePerm(request, "admin");
  if (auth instanceof Response) return auth;
  const admin = adminClient();
  if (admin instanceof Response) return admin;
  try {
    const users = (await listAll(admin)).map(toAdminUser).sort((a, b) => a.loginId.localeCompare(b.loginId));
    return Response.json({ users, me: auth.userId });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}

type Action =
  | { action: "create"; loginId: string; name?: string; password: string; roles: Role[]; notifyEmail?: string }
  | { action: "update"; id: string; name?: string; roles?: Role[]; notifyEmail?: string }
  | { action: "password"; id: string; password: string }
  | { action: "disable" | "enable"; id: string }
  | { action: "testMail"; id: string };

export async function POST(request: Request) {
  const auth = await requirePerm(request, "admin");
  if (auth instanceof Response) return auth;
  const admin = adminClient();
  if (admin instanceof Response) return admin;
  const a = (await request.json().catch(() => null)) as Action | null;
  if (!a || typeof a !== "object") return fail("要求の形式が正しくありません");

  try {
    switch (a.action) {
      case "create": {
        const raw = String(a.loginId ?? "").trim().toLowerCase();
        // @ を含めばメールアドレス、含まなければログイン ID（@valve-check.local を付ける）
        const email = raw.includes("@") ? raw : `${raw}@${LOGIN_DOMAIN}`;
        const loginId = loginIdOf(email);
        if (!/^[a-z0-9._-]{2,64}$/.test(loginId)) return fail("ログインIDは半角の英小文字・数字・「. _ -」で2〜64文字にしてください");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("メールアドレスの形式が正しくありません");
        if (String(a.password ?? "").length < 8) return fail("パスワードは8文字以上にしてください");
        const roles = parseRoles(a.roles);
        if (!roles?.length) return fail("権限を1つ以上選んでください");
        // ログイン画面は @ より前で探すため、同じログイン ID の利用者は作らない
        const users = await listAll(admin);
        if (users.some((u) => loginIdOf(u.email) === loginId)) return fail(`ログインID「${loginId}」はすでに使われています`);
        const name = String(a.name ?? "").trim();
        const notify = String(a.notifyEmail ?? "").trim();
        if (notify && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(notify)) return fail("通知先メールの形式が正しくありません");
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password: a.password,
          email_confirm: true,
          app_metadata: { roles },
          user_metadata: { ...(name ? { name } : {}), ...(notify ? { notify_email: notify } : {}) },
        });
        if (error) return fail(error.message);
        return Response.json({ user: toAdminUser(data.user) });
      }
      case "update": {
        const { data: cur, error: e1 } = await admin.auth.admin.getUserById(a.id);
        if (e1 || !cur.user) return fail("利用者が見つかりません", 404);
        const patch: { app_metadata?: object; user_metadata?: object } = {};
        if (a.roles !== undefined) {
          const roles = parseRoles(a.roles);
          if (!roles?.length) return fail("権限を1つ以上選んでください");
          if (a.id === auth.userId && !roles.includes("admin") && !auth.envAdmin && !otherAdminExists(await listAll(admin), auth.userId)) {
            return fail("ほかに管理者がいないため、自分の管理者権限は外せません");
          }
          if (envAdminIds().has(loginIdOf(cur.user.email)) && !roles.includes("admin")) {
            return fail("この利用者は環境変数 ADMIN_LOGIN_IDS で管理者に指定されているため、管理者権限は外せません");
          }
          patch.app_metadata = { roles };
        }
        if (a.name !== undefined || a.notifyEmail !== undefined) {
          const notify = a.notifyEmail === undefined ? notifyEmailOf(cur.user) ?? "" : String(a.notifyEmail).trim();
          if (notify && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(notify)) return fail("通知先メールの形式が正しくありません");
          patch.user_metadata = {
            ...(cur.user.user_metadata ?? {}),
            ...(a.name !== undefined ? { name: String(a.name).trim() } : {}),
            notify_email: notify || null,
          };
        }
        const { data, error } = await admin.auth.admin.updateUserById(a.id, patch);
        if (error) return fail(error.message);
        return Response.json({ user: toAdminUser(data.user) });
      }
      case "password": {
        if (String(a.password ?? "").length < 8) return fail("パスワードは8文字以上にしてください");
        const { data, error } = await admin.auth.admin.updateUserById(a.id, { password: a.password });
        if (error) return fail(error.message);
        return Response.json({ user: toAdminUser(data.user) });
      }
      case "disable":
      case "enable": {
        if (a.action === "disable") {
          if (a.id === auth.userId) return fail("自分自身は無効にできません");
          const { data: cur } = await admin.auth.admin.getUserById(a.id);
          if (cur.user && envAdminIds().has(loginIdOf(cur.user.email))) {
            return fail("この利用者は環境変数 ADMIN_LOGIN_IDS で管理者に指定されているため、無効にできません");
          }
        }
        const { data, error } = await admin.auth.admin.updateUserById(a.id, {
          ban_duration: a.action === "disable" ? BAN_FOREVER : "none",
        });
        if (error) return fail(error.message);
        return Response.json({ user: toAdminUser(data.user) });
      }
      case "testMail": {
        const method = mailMethod();
        if (!method) return fail("メールの送信方法が設定されていません（SMTP_USER・SMTP_PASS か RESEND_API_KEY を環境変数に設定してください）");
        const { data: cur } = await admin.auth.admin.getUserById(a.id);
        const to = cur.user ? notifyEmailOf(cur.user) : null;
        if (!to) return fail("この利用者には通知先メールが登録されていません");
        try {
          await sendMails([
            {
              to,
              subject: "【バルブ点検】テストメール",
              text: `バルブ点検アプリからのテストメールです（送信方法：${method === "smtp" ? "SMTP" : "Resend"}、送った人：${auth.name}）。\nこのメールが届けば、承認フローのメールを送れます。⑤ チェックリスト作成のルールの「共通」で、拠点ごとに送信をオンにしてください。\n`,
            },
          ]);
        } catch (e) {
          return fail(`送信できませんでした：${e instanceof Error ? e.message : String(e)}`, 502);
        }
        return Response.json({ ok: true, to });
      }
      default:
        return fail("不明な操作です");
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}
