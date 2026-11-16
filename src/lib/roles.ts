// 権限（ロール）の定義。画面（メニューの表示・ページの入口）と API の両方でこの定義を使う。
//
// 権限は1人に複数付けられる（例：チームリーダー＋制御室）。保存先は Supabase Auth の app_metadata.roles
// （service role キーでしか書き換えられず、ログインのトークンにも入るので利用者が改ざんできない）。
// - 作業者 worker   ：チェックリストの作成（承認依頼）・実施、QR コード印刷
// - チームリーダー approver：チェックリストの承認（1段目）、② の実施・QR 印刷（作成はしない）
// - G長 manager     ：チェックリストの承認（2段目）、② の実施・QR 印刷（作成はしない）
// - 制御室 control  ：③ 制御室・既存系の制御室ダッシュボード（運用入力・弁の手動変更・停止範囲・現場記録の確認）、
//                     チェックリストの承認（3段目。⑤ の設定で有無を決める）
// 承認フローの決まりは src/lib/piping/approval.ts。
// - 管理者 admin    ：チェックリストの作成以外のすべて（ユーザー管理、④ 系統図データ管理、⑤ チェックリスト作成のルール、機器マスター、
//                     承認のどの段も）。作成者本人は承認できないため、作成は作業者だけにして作成と承認を分ける

export const ROLES = ["worker", "approver", "manager", "control", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  worker: "作業者",
  approver: "チームリーダー",
  manager: "G長",
  control: "制御室",
  admin: "管理者",
};

export const ROLE_DESC: Record<Role, string> = {
  worker: "チェックリストの作成（承認依頼）・実施、QRコード印刷",
  approver: "チェックリストの承認（1段目）、② 現場点検・QRコード印刷（作成はしない）",
  manager: "チェックリストの承認（2段目）、② 現場点検・QRコード印刷（作成はしない）",
  control: "③ 制御室（運用入力・弁の手動変更・運用停止範囲・現場記録の確認）、チェックリストの承認（3段目）",
  admin: "チェックリストの作成以外のすべて（ユーザー管理、④ 系統図データ管理、⑤ ルール、機器マスター、承認）",
};

/** 権限で許される操作の単位 */
export type Permission =
  | "create" // チェックリストの作成・承認依頼（作業者＝現場担当者）
  | "checklist" // チェックリストの実施（② 現場点検など）
  | "qr" // QR コード印刷（作業者）
  | "approveLeader" // チェックリストの承認（チームリーダーの段）
  | "approveManager" // チェックリストの承認（G長の段）
  | "control" // 制御室
  | "admin"; // 管理（ユーザー・系統図データ・ルール・機器マスター）

const GRANTS: Record<Role, Permission[]> = {
  worker: ["create", "checklist", "qr"],
  approver: ["checklist", "qr", "approveLeader"],
  manager: ["checklist", "qr", "approveManager"],
  control: ["control"],
  // 作成（create）は付けない：作成者本人は承認できないため、作成は作業者、承認はそれ以外の人に分ける
  admin: ["checklist", "qr", "approveLeader", "approveManager", "control", "admin"],
};

/** 保存値を権限の一覧にそろえる（知らない値は捨てる）。未設定なら null */
export function parseRoles(raw: unknown): Role[] | null {
  if (!Array.isArray(raw)) return null;
  return ROLES.filter((r) => raw.includes(r));
}

export function permissionsOf(roles: readonly Role[]): Set<Permission> {
  return new Set(roles.flatMap((r) => GRANTS[r]));
}

/** いずれかの権限を持っていれば true */
export function can(roles: readonly Role[] | null | undefined, ...perms: Permission[]) {
  if (!roles) return false;
  const p = permissionsOf(roles);
  return perms.some((x) => p.has(x));
}

/**
 * ページごとに必要な権限（どれか1つあれば開ける）。上から順に、パスの先頭が一致した最初の行を使う。
 * 載っていないページ（ホーム・配管系統図トップ・音声設定・印刷プレビュー）はログインしていれば開ける。
 */
export const PAGE_PERMS: { prefix: string; perms: Permission[] }[] = [
  { prefix: "/admin", perms: ["admin"] },
  // 既存系
  { prefix: "/equipment/print", perms: ["qr"] },
  { prefix: "/equipment", perms: ["admin"] },
  { prefix: "/checklists", perms: ["checklist"] },
  { prefix: "/inspect", perms: ["checklist"] },
  { prefix: "/control-room", perms: ["control"] },
  // 配管系統図系
  // ① は作成（作業者）と承認（チームリーダー・G長・制御室）の両方で開く
  { prefix: "/piping/planner", perms: ["create", "approveLeader", "approveManager", "control"] },
  { prefix: "/piping/field", perms: ["checklist"] },
  { prefix: "/piping/control", perms: ["control"] },
  { prefix: "/piping/qr", perms: ["qr"] },
  { prefix: "/piping/data", perms: ["admin"] },
  { prefix: "/piping/editor", perms: ["admin"] },
  { prefix: "/piping/rules", perms: ["admin"] },
];

export function pagePerms(pathname: string): Permission[] | null {
  const hit = PAGE_PERMS.find((p) => pathname === p.prefix || pathname.startsWith(`${p.prefix}/`));
  return hit ? hit.perms : null;
}

export function canOpen(roles: readonly Role[] | null | undefined, pathname: string) {
  const need = pagePerms(pathname);
  return !need || can(roles, ...need);
}

/** 配管系統図の共有ストア（/api/piping の POST）の操作ごとに必要な権限 */
export const STORE_ACTION_PERMS: Record<string, Permission[]> = {
  // チェックリストの作成・承認依頼（作業者）
  savePlan: ["create"],
  deletePlan: ["create"],
  setPlanPeriod: ["create"],
  // 実施
  startExecution: ["checklist"],
  record: ["checklist"],
  undoRecord: ["checklist"],
  advanceStep: ["checklist"],
  completeExecution: ["checklist"],
  deleteExecution: ["checklist"],
  // 当日の選択・工程の完了報告は現場と制御室の両方で行う
  setDayParams: ["checklist", "control"],
  setFillSupply: ["checklist", "control"],
  markStepDone: ["checklist", "control"],
  // 承認・差し戻し（どの段を承認できるかは /api/piping の中で確かめる。制御室の段は ③ で行う）
  approvePlan: ["approveLeader", "approveManager", "control"],
  rejectPlan: ["approveLeader", "approveManager", "control"],
  // 制御室
  confirm: ["control"],
  setOutage: ["control"],
  clearOutages: ["control"],
  setOperations: ["control"],
  setValve: ["control"],
  clearValveOverrides: ["control"],
  setOutageDefs: ["control"],
  // 管理
  setRules: ["admin"],
  // 系統図の版の切り替えに合わせたチェックリストの更新・差し戻し（版の切り替えと同じく管理者）
  applyDiagramImpact: ["admin"],
};

/** 権限が足りないときの案内文 */
export function deniedMessage(perms: Permission[]) {
  const roles = ROLES.filter((r) => perms.some((p) => GRANTS[r].includes(p) && r !== "admin"));
  const names = (roles.length ? roles : (["admin"] as Role[])).map((r) => ROLE_LABEL[r]);
  return `この操作には${names.join("・")}${names.length > 1 ? "のいずれかの" : ""}権限が必要です`;
}

// ───────────── 拠点ごとの権限 ─────────────
// 利用者・承認者は拠点ごとに違うため、権限は拠点ごとに持つ（app_metadata.siteRoles = { 拠点ID: 権限[] }）。
// 管理者だけは全拠点共通（app_metadata.roles の admin）。app_metadata.roles には全拠点を合わせた権限も入れる
// （既存の QR チェックリスト系の画面と DB 側の RLS は拠点を区別しないため）。
// siteRoles が未設定の利用者は、今までどおり roles がすべての拠点に効く。

export type SiteRoles = Record<string, Role[]>;

/** 拠点ごとの権限を持たない権限（全拠点共通） */
export const GLOBAL_ROLES: Role[] = ["admin"];
export const SITE_ROLES: Role[] = ROLES.filter((r) => !GLOBAL_ROLES.includes(r));

export const FACILITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 保存値を拠点ごとの権限にそろえる（未設定なら null） */
export function parseSiteRoles(raw: unknown): SiteRoles | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: SiteRoles = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!FACILITY_ID_RE.test(k)) continue;
    const roles = (parseRoles(v) ?? []).filter((r) => SITE_ROLES.includes(r));
    if (roles.length) out[k] = roles;
  }
  return out;
}

/** 全拠点を合わせた権限（拠点の区別が無い画面・DB 用）＋管理者 */
export function unionRoles(siteRoles: SiteRoles, admin: boolean): Role[] {
  const all = new Set(Object.values(siteRoles).flat());
  if (admin) all.add("admin");
  return ROLES.filter((r) => all.has(r));
}

/** ある拠点での権限。roles は全拠点共通の保存値（siteRoles が無ければそのまま全拠点に効く） */
export function rolesAt(access: { roles: readonly Role[]; siteRoles: SiteRoles | null }, facility: string): Role[] {
  if (!access.siteRoles) return [...access.roles];
  const here = access.siteRoles[facility] ?? [];
  return access.roles.includes("admin") ? [...here, "admin"] : [...here];
}

/**
 * 拠点の見え方：full＝権限のある拠点、view＝表示だけ（どこかの拠点で制御室の人は、ほかの拠点も表示できる）、none＝表示しない
 */
export function siteAccess(access: { roles: readonly Role[]; siteRoles: SiteRoles | null }, facility: string): "full" | "view" | "none" {
  if (rolesAt(access, facility).length) return "full";
  if (access.roles.includes("control")) return "view";
  return "none";
}
