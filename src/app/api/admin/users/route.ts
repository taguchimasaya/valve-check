import type { User } from "@supabase/supabase-js";
import { adminClient, displayNameOf, envAdminIds, isDisabled, loginIdOf, requirePerm, rolesOf } from "@/lib/serverAuth";
import { parseRoles, parseSiteRoles, unionRoles, type Role, type SiteRoles } from "@/lib/roles";
import { mailMethod, notifyEmailOf, sendMails } from "@/lib/approvalMail";

// ユーザー管理 API（管理者のみ）。利用者の作成・権限変更・無効化は service role キーで Supabase Auth を操作する。
// GET                                        … 利用者の一覧
// POST {action:"create", loginId, name, password, siteRoles, admin, roles} … 利用者を作成（メールの確認なしですぐ使える）
//   権限は拠点ごと（siteRoles = { 拠点ID: 権限[] }）＋全拠点共通の管理者（admin）。
//   siteRoles を null にすると、roles が全拠点に効く（拠点ごとの権限を付ける前の利用者と同じ扱い）
// POST {action:"update", id, name?, roles?, notifyEmail?} … 名前・権限・通知先メール（承認フローのメールの宛先）の変更
// POST {action:"password", id, password}     … パスワードの再設定
// POST {action:"disable" | "enable", id}     … 無効化（ログインできなくする）・有効に戻す
// POST {action:"testMail", id, force?}       … 通知先メールにテストメールを送る（メールの設定の確認用）。
//   送れたら app_metadata.test_mail = {to, at} に記録し、同じアドレスには force が無い限り送らない
// POST {action:"testMailBulk", ids}          … 複数の利用者にまとめて送る（1回 20 人まで。送信済み・通知先なし・無効は飛ばす）
// POST {action:"resetTestMail", id}          … 送信済みの記録を消す（もう一度送れるようにする）

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
  /** 全拠点を合わせた権限 */
  roles: Role[];
  /** 拠点ごとの権限（null なら roles が全拠点に効く） */
  siteRoles: SiteRoles | null;
  /** 権限が未設定（何もできない） */
  rolesUnset: boolean;
  envAdmin: boolean;
  disabled: boolean;
  /** テストメールを送れた記録（宛先と日時）。今の通知先と違うアドレスの記録は「未送信」扱い */
  testMail: { to: string; at: string } | null;
  /** 今の通知先メールにテストメールを送信済み */
  testMailDone: boolean;
  createdAt: string;
  lastSignInAt: string | null;
};

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

/** app_metadata のテストメール送信済みの記録 */
function testMailOf(u: User): { to: string; at: string } | null {
  const t = (u.app_metadata as { test_mail?: unknown } | undefined)?.test_mail as { to?: unknown; at?: unknown } | undefined;
  return t && typeof t.to === "string" && typeof t.at === "string" ? { to: t.to, at: t.at } : null;
}
const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function toAdminUser(u: User): AdminUser {
  const { roles, siteRoles, envAdmin, stored } = rolesOf(u);
  const notify = notifyEmailOf(u) ?? "";
  const testMail = testMailOf(u);
  return {
    id: u.id,
    loginId: loginIdOf(u.email),
    email: u.email ?? "",
    name: displayNameOf(u),
    notifyEmail: notify,
    roles,
    siteRoles,
    rolesUnset: stored === null && !siteRoles,
    envAdmin,
    disabled: isDisabled(u),
    testMail,
    testMailDone: !!notify && !!testMail && sameAddress(testMail.to, notify),
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
  const auth = await requirePerm(request, "users");
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

/** 権限の指定：拠点ごとの権限（siteRoles）＋管理者（admin）。siteRoles が null なら roles を全拠点に */
type AccessInput = { roles?: Role[]; siteRoles?: SiteRoles | null; admin?: boolean };

/** 保存する app_metadata（roles には全拠点を合わせた権限も入れる：既存系の画面と DB 側の RLS 用） */
function accessOf(a: AccessInput): { roles: Role[]; siteRoles: SiteRoles | null } | string {
  const legacy = parseRoles(a.roles) ?? [];
  const admin = a.admin ?? legacy.includes("admin");
  if (a.siteRoles) {
    const siteRoles = parseSiteRoles(a.siteRoles) ?? {};
    const roles = unionRoles(siteRoles, admin);
    return roles.length ? { roles, siteRoles } : "権限を1つ以上選んでください（管理者でなければ、どこかの拠点に権限が必要です）";
  }
  const roles = [...legacy.filter((r) => r !== "admin"), ...(admin ? (["admin"] as Role[]) : [])];
  return roles.length ? { roles, siteRoles: null } : "権限を1つ以上選んでください";
}

type Action =
  | ({ action: "create"; loginId: string; name?: string; password: string; notifyEmail?: string } & AccessInput)
  | ({ action: "update"; id: string; name?: string; notifyEmail?: string } & AccessInput)
  | { action: "password"; id: string; password: string }
  | { action: "disable" | "enable"; id: string }
  | { action: "testMail"; id: string; force?: boolean }
  | { action: "testMailBulk"; ids: string[] }
  | { action: "resetTestMail"; id: string };

export type TestMailResult = { id: string; status: "sent" | "skipped" | "noAddress" | "disabled" | "error"; to?: string; error?: string };
const BULK_MAX = 20;

export async function POST(request: Request) {
  const auth = await requirePerm(request, "users");
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
        const access = accessOf(a);
        if (typeof access === "string") return fail(access);
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
          app_metadata: access,
          user_metadata: { ...(name ? { name } : {}), ...(notify ? { notify_email: notify } : {}) },
        });
        if (error) return fail(error.message);
        return Response.json({ user: toAdminUser(data.user) });
      }
      case "update": {
        const { data: cur, error: e1 } = await admin.auth.admin.getUserById(a.id);
        if (e1 || !cur.user) return fail("利用者が見つかりません", 404);
        const patch: { app_metadata?: object; user_metadata?: object } = {};
        if (a.roles !== undefined || a.siteRoles !== undefined || a.admin !== undefined) {
          const access = accessOf(a);
          if (typeof access === "string") return fail(access);
          const roles = access.roles;
          if (a.id === auth.userId && !roles.includes("admin") && !auth.envAdmin && !otherAdminExists(await listAll(admin), auth.userId)) {
            return fail("ほかに管理者がいないため、自分の管理者権限は外せません");
          }
          if (envAdminIds().has(loginIdOf(cur.user.email)) && !roles.includes("admin")) {
            return fail("この利用者は環境変数 ADMIN_LOGIN_IDS で管理者に指定されているため、管理者権限は外せません");
          }
          // テストメールの送信済みの記録などは残す
          patch.app_metadata = { ...(cur.user.app_metadata ?? {}), ...access };
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
        if (!cur.user) return fail("利用者が見つかりません", 404);
        const r = await sendTestMail(admin, cur.user, method, auth.name, !!a.force);
        if (r.status === "noAddress") return fail("この利用者には通知先メールが登録されていません");
        if (r.status === "error") return fail(`送信できませんでした：${r.error}`, 502);
        return Response.json({ ok: true, ...r });
      }
      case "testMailBulk": {
        const method = mailMethod();
        if (!method) return fail("メールの送信方法が設定されていません（SMTP_USER・SMTP_PASS か RESEND_API_KEY を環境変数に設定してください）");
        const ids = Array.isArray(a.ids) ? [...new Set(a.ids.map(String))] : [];
        if (!ids.length) return fail("送る利用者がいません");
        if (ids.length > BULK_MAX) return fail(`1回に送れるのは${BULK_MAX}人までです`);
        const results: TestMailResult[] = [];
        for (const id of ids) {
          const { data: cur } = await admin.auth.admin.getUserById(id);
          if (!cur.user) {
            results.push({ id, status: "error", error: "利用者が見つかりません" });
            continue;
          }
          if (isDisabled(cur.user)) {
            results.push({ id, status: "disabled" });
            continue;
          }
          results.push({ id, ...(await sendTestMail(admin, cur.user, method, auth.name, false)) });
        }
        return Response.json({ results });
      }
      case "resetTestMail": {
        const { data: cur, error: e1 } = await admin.auth.admin.getUserById(a.id);
        if (e1 || !cur.user) return fail("利用者が見つかりません", 404);
        const { data, error } = await admin.auth.admin.updateUserById(a.id, { app_metadata: { ...(cur.user.app_metadata ?? {}), test_mail: null } });
        if (error) return fail(error.message);
        return Response.json({ user: toAdminUser(data.user) });
      }
      default:
        return fail("不明な操作です");
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}

/** テストメールを1人に送り、送れたら送信済みを記録する。送信済み（今の通知先と同じアドレス）は force が無ければ送らない */
async function sendTestMail(
  admin: Admin,
  u: User,
  method: "smtp" | "resend",
  sender: string,
  force: boolean
): Promise<Omit<TestMailResult, "id">> {
  const to = notifyEmailOf(u);
  if (!to) return { status: "noAddress" };
  const done = testMailOf(u);
  if (!force && done && sameAddress(done.to, to)) return { status: "skipped", to };
  try {
    await sendMails([
      {
        to,
        subject: "【バルブ点検】テストメール",
        text: `バルブ点検アプリからのテストメールです（送信方法：${method === "smtp" ? "SMTP" : "Resend"}、送った人：${sender}）。
このメールが届けば、承認フローのメールを送れます。⑤ チェックリスト作成のルールの「共通」で、拠点ごとに送信をオンにしてください。
`,
      },
    ]);
  } catch (e) {
    return { status: "error", to, error: e instanceof Error ? e.message : String(e) };
  }
  const { error } = await admin.auth.admin.updateUserById(u.id, {
    app_metadata: { ...(u.app_metadata ?? {}), test_mail: { to, at: new Date().toISOString() } },
  });
  // 送信はできたので、記録に失敗しても送信済みとして返す（次回の一括送信で重複する可能性だけ伝える）
  return error ? { status: "sent", to, error: `送信済みの記録に失敗：${error.message}` } : { status: "sent", to };
}
