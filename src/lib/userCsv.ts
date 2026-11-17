// ユーザー管理の CSV 入出力（一括設定）。画面（/admin/users）で使う。サーバーへの保存は既存の /api/admin/users を1件ずつ呼ぶ。
//
// 列：ログインID / 表示名 / 通知先メール / 状態（有効・無効） / 管理者（○） / 拠点ごとの権限（列名「権限:拠点名(拠点ID)」） /
//     初期パスワード（新しい利用者だけ） / テストメール（出力だけ。取り込みでは見ない）
// 権限の欄は「チームリーダー・制御室」のように「・」「、」「,」「/」「空白」で区切る（英語のキー worker なども可）。空欄はその拠点で権限なし。
// CSV に無い拠点の列は今の設定のまま。状態・管理者の列が無い／空欄なら今のまま。

import { ROLE_LABEL, SITE_ROLES, type Role, type SiteRoles } from "./roles";

export type CsvFacility = { id: string; name: string };

/** 一覧の利用者（/api/admin/users の AdminUser のうち CSV で使う分） */
export type CsvUser = {
  id: string;
  loginId: string;
  name: string;
  notifyEmail: string;
  roles: Role[];
  siteRoles: SiteRoles | null;
  envAdmin: boolean;
  disabled: boolean;
  testMailDone: boolean;
  testMail: { to: string; at: string } | null;
};

export type Access = { admin: boolean; siteRoles: SiteRoles | null; roles: Role[] };

export const COL = {
  loginId: "ログインID",
  name: "表示名",
  notifyEmail: "通知先メール",
  status: "状態",
  admin: "管理者",
  password: "初期パスワード",
  testMail: "テストメール",
} as const;
const SITE_PREFIX = "権限:";

/** 拠点での権限（拠点ごとに分ける前の利用者は、全拠点共通の権限） */
export function rolesAtFacility(u: Pick<CsvUser, "roles" | "siteRoles">, facilityId: string): Role[] {
  return u.siteRoles ? u.siteRoles[facilityId] ?? [] : u.roles.filter((r) => r !== "admin");
}

// ───── CSV の読み書き ─────

const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsvText(rows: string[][]) {
  // Excel で文字化けしないよう BOM を付ける
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

export function parseCsvText(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** ファイルの中身を文字列に（UTF-8 で読めなければ Excel の既定の Shift_JIS） */
export function decodeCsv(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    return utf8;
  }
}

const siteHeader = (f: CsvFacility) => `${SITE_PREFIX}${f.name}(${f.id})`;
const fmtAt = (at: string) => new Date(at).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function usersToCsv(users: CsvUser[], facilities: CsvFacility[]): string {
  const head = [COL.loginId, COL.name, COL.notifyEmail, COL.status, COL.admin, ...facilities.map(siteHeader), COL.password, COL.testMail];
  const body = users.map((u) => [
    u.loginId,
    u.name,
    u.notifyEmail,
    u.disabled ? "無効" : "有効",
    u.roles.includes("admin") ? "○" : "",
    ...facilities.map((f) => rolesAtFacility(u, f.id).map((r) => ROLE_LABEL[r]).join("・")),
    "",
    !u.notifyEmail ? "通知先なし" : u.testMailDone && u.testMail ? `送信済み ${fmtAt(u.testMail.at)}` : "未送信",
  ]);
  return toCsvText([head, ...body]);
}

// ───── 取り込み：今の設定との差分を作る ─────

const ROLE_BY_TEXT = new Map<string, Role>(
  SITE_ROLES.flatMap((r) => [
    [ROLE_LABEL[r], r],
    [r, r],
  ])
);
ROLE_BY_TEXT.set("承認者", "approver"); // 以前の呼び方
ROLE_BY_TEXT.set("ベンダー", "vendor");

function parseRoleCell(v: string): { roles: Role[]; unknown: string[] } {
  const parts = v
    .split(/[・、,，/／\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const roles = new Set<Role>();
  const unknown: string[] = [];
  for (const p of parts) {
    const r = ROLE_BY_TEXT.get(p) ?? ROLE_BY_TEXT.get(p.toLowerCase());
    if (r) roles.add(r);
    else unknown.push(p);
  }
  return { roles: SITE_ROLES.filter((r) => roles.has(r)), unknown };
}

const YES = new Set(["○", "〇", "◯", "1", "true", "yes", "はい", "y"]);
const NO = new Set(["×", "0", "false", "no", "いいえ", "n", "-", "－"]);

export type ImportChange =
  | { kind: "create"; line: number; loginId: string; body: Record<string, unknown>; summary: string[] }
  | {
      kind: "update";
      line: number;
      loginId: string;
      id: string;
      /** 名前・通知先・権限の更新（無ければ null） */
      body: Record<string, unknown> | null;
      /** 状態の変更 */
      status: "enable" | "disable" | null;
      summary: string[];
    };

export type ImportPlan = { changes: ImportChange[]; errors: { line: number; message: string }[]; unchanged: number };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function planImport(rows: string[][], users: CsvUser[], facilities: CsvFacility[]): ImportPlan {
  const plan: ImportPlan = { changes: [], errors: [], unchanged: 0 };
  if (!rows.length) {
    plan.errors.push({ line: 1, message: "CSV が空です" });
    return plan;
  }
  const head = rows[0].map((h) => h.trim());
  const idx = (name: string) => head.indexOf(name);
  const iLogin = idx(COL.loginId);
  if (iLogin < 0) {
    plan.errors.push({ line: 1, message: `「${COL.loginId}」の列がありません（ユーザー管理の CSV 出力の形式で作ってください）` });
    return plan;
  }
  const iName = idx(COL.name);
  const iNotify = idx(COL.notifyEmail);
  const iStatus = idx(COL.status);
  const iAdmin = idx(COL.admin);
  const iPassword = idx(COL.password);
  // 拠点の列：「権限:名前(ID)」の ID で拠点を探す（無ければ名前で）
  const siteCols: { i: number; facility: string }[] = [];
  head.forEach((h, i) => {
    if (!h.startsWith(SITE_PREFIX)) return;
    const m = h.match(/\(([^()]+)\)\s*$/);
    const f = facilities.find((x) => x.id === m?.[1]) ?? facilities.find((x) => x.name === h.slice(SITE_PREFIX.length).replace(/\([^()]*\)\s*$/, "").trim());
    if (f) siteCols.push({ i, facility: f.id });
    else plan.errors.push({ line: 1, message: `列「${h}」の拠点が見つかりません（この列は読み飛ばします）` });
  });

  const byLogin = new Map(users.map((u) => [u.loginId.toLowerCase(), u]));
  const seen = new Set<string>();
  const facilityName = (id: string) => facilities.find((f) => f.id === id)?.name ?? id;

  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const cell = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const has = (i: number) => i >= 0 && i < r.length;
    const raw = cell(iLogin).toLowerCase();
    if (!raw) return;
    const loginId = raw.includes("@") ? raw.split("@")[0] : raw;
    if (seen.has(loginId)) {
      plan.errors.push({ line, message: `ログインID「${loginId}」が重複しています` });
      return;
    }
    seen.add(loginId);

    const errs: string[] = [];
    // 権限
    const site: SiteRoles = {};
    for (const c of siteCols) {
      const { roles, unknown } = parseRoleCell(cell(c.i));
      if (unknown.length) errs.push(`${facilityName(c.facility)}の権限「${unknown.join("・")}」が分かりません`);
      site[c.facility] = roles;
    }
    const adminText = cell(iAdmin).toLowerCase();
    const adminVal = !has(iAdmin) || adminText === "" ? null : YES.has(adminText) ? true : NO.has(adminText) ? false : undefined;
    if (adminVal === undefined) errs.push(`管理者の欄は「○」か空欄にしてください（「${cell(iAdmin)}」）`);
    const statusText = cell(iStatus);
    const statusVal = statusText === "" ? null : statusText === "有効" ? "enable" : statusText === "無効" ? "disable" : undefined;
    if (statusVal === undefined) errs.push(`状態は「有効」か「無効」にしてください（「${statusText}」）`);
    const notify = has(iNotify) ? cell(iNotify) : null;
    if (notify && !EMAIL_RE.test(notify)) errs.push(`通知先メール「${notify}」の形式が正しくありません`);
    const name = has(iName) ? cell(iName) : null;
    if (errs.length) {
      errs.forEach((m) => plan.errors.push({ line, message: `${loginId}：${m}` }));
      return;
    }

    const cur = byLogin.get(loginId);
    if (!cur) {
      // 新しい利用者
      const password = cell(iPassword);
      const admin = adminVal === true;
      const siteRoles = Object.fromEntries(Object.entries(site).filter(([, v]) => v.length));
      if (password.length < 8) {
        plan.errors.push({ line, message: `${loginId}：新しい利用者には「${COL.password}」（8文字以上）が必要です` });
        return;
      }
      if (!admin && !Object.keys(siteRoles).length) {
        plan.errors.push({ line, message: `${loginId}：新しい利用者には、管理者かどこかの拠点の権限が必要です` });
        return;
      }
      plan.changes.push({
        kind: "create",
        line,
        loginId,
        body: { action: "create", loginId: raw, name: name ?? "", password, notifyEmail: notify ?? "", admin, siteRoles, roles: [] },
        summary: [
          `新規作成${admin ? "（管理者）" : ""}`,
          ...Object.entries(siteRoles).map(([f, rs]) => `${facilityName(f)}：${rs.map((x) => ROLE_LABEL[x]).join("・")}`),
        ],
      });
      if (statusVal === "disable") plan.errors.push({ line, message: `${loginId}：新しい利用者は「有効」で作成します（無効にするのは作成後に）` });
      return;
    }

    // 既存の利用者：違うところだけ
    const summary: string[] = [];
    const body: Record<string, unknown> = { action: "update", id: cur.id };
    if (name !== null && name !== cur.name) {
      body.name = name;
      summary.push(`表示名：${cur.name || "（なし）"} → ${name || "（なし）"}`);
    }
    if (notify !== null && notify !== cur.notifyEmail) {
      body.notifyEmail = notify;
      summary.push(`通知先：${cur.notifyEmail || "（なし）"} → ${notify || "（なし）"}`);
    }
    const curAdmin = cur.roles.includes("admin");
    const admin = adminVal ?? curAdmin;
    // CSV に無い拠点は今のまま。拠点ごとに分ける前の利用者は、今の共通の権限を全拠点に広げてから重ねる
    const nextSite: SiteRoles = {};
    for (const f of facilities) nextSite[f.id] = rolesAtFacility(cur, f.id);
    Object.assign(nextSite, site);
    const roleDiff = facilities.filter((f) => rolesAtFacility(cur, f.id).join() !== (nextSite[f.id] ?? []).join());
    if (roleDiff.length || admin !== curAdmin) {
      const siteRoles = Object.fromEntries(Object.entries(nextSite).filter(([, v]) => v.length));
      if (!admin && !Object.keys(siteRoles).length) {
        plan.errors.push({ line, message: `${loginId}：権限がすべて無くなります（無効にするときは状態を「無効」にしてください）` });
        return;
      }
      if (cur.envAdmin && !admin) {
        plan.errors.push({ line, message: `${loginId}：環境変数 ADMIN_LOGIN_IDS の管理者は、管理者を外せません` });
        return;
      }
      Object.assign(body, { admin, siteRoles, roles: [] });
      if (admin !== curAdmin) summary.push(admin ? "管理者を付ける" : "管理者を外す");
      roleDiff.forEach((f) =>
        summary.push(
          `${f.name}：${rolesAtFacility(cur, f.id).map((x) => ROLE_LABEL[x]).join("・") || "なし"} → ${(nextSite[f.id] ?? []).map((x) => ROLE_LABEL[x]).join("・") || "なし"}`
        )
      );
    }
    const status = statusVal === "disable" && !cur.disabled ? "disable" : statusVal === "enable" && cur.disabled ? "enable" : null;
    if (status) summary.push(status === "disable" ? "無効にする" : "有効に戻す");
    const hasBody = Object.keys(body).length > 2;
    if (!hasBody && !status) {
      plan.unchanged++;
      return;
    }
    plan.changes.push({ kind: "update", line, loginId, id: cur.id, body: hasBody ? body : null, status, summary });
  });
  return plan;
}
