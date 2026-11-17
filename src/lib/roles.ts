// 権限（ロール）と機能の定義。画面（メニューの表示・ページの入口）・API・DB 側の制限（RLS）でこの定義を使う。
//
// ロールは1人に複数付けられる（例：チームリーダー＋制御室）。保存先は Supabase Auth の app_metadata.roles / siteRoles
// （service role キーでしか書き換えられず、ログインのトークンにも入るので利用者が改ざんできない）。
// ロールごとに使える機能（権限×機能の表）は、管理者が「権限の設定」（/admin/roles）で変えられる（全拠点共通）。
// 表は DB の app_settings（key = role_grants）に保存し、未設定なら DEFAULT_GRANTS を使う。
// DB 側の RLS も同じ表を読む（supabase/role_grants.sql の has_perm）。
// 承認フローの決まりは src/lib/piping/approval.ts。作成者本人は承認できないため、既定では作成は作業者だけ。

export const ROLES = ["worker", "approver", "manager", "control", "vendor", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  worker: "作業者",
  approver: "チームリーダー",
  manager: "G長",
  control: "制御室",
  vendor: "外部ベンダー",
  admin: "管理者",
};

/** 機能（権限×機能の表の行） */
export const PERMISSIONS = [
  "create",
  "checklist",
  "qr",
  "approveLeader",
  "approveManager",
  "approveControl",
  "control",
  "diagram",
  "rules",
  "equipment",
  "users",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_INFO: Record<Permission, { label: string; desc: string; group: string }> = {
  create: { label: "チェックリストの作成", desc: "① チェックリスト作成・承認依頼、差し戻しの手直し、削除・周期の変更、Excel 取込", group: "チェックリスト" },
  checklist: { label: "点検の実施", desc: "② 現場点検、既存の QR チェックリスト点検", group: "チェックリスト" },
  qr: { label: "QRコード・NFCタグ", desc: "機器の QR コード印刷、NFC タグの登録", group: "チェックリスト" },
  approveLeader: { label: "承認（チームリーダーの段）", desc: "承認フローの1段目の承認・差し戻し", group: "承認" },
  approveManager: { label: "承認（G長の段）", desc: "承認フローの2段目の承認・差し戻し", group: "承認" },
  approveControl: { label: "承認（制御室の段）", desc: "承認フローの3段目の承認・差し戻し（⑤ の設定で段の有無を決める）", group: "承認" },
  control: { label: "制御室", desc: "③ 制御室・制御室ダッシュボード（運用入力・弁の手動変更・運用停止範囲・現場記録の確認）", group: "制御室" },
  diagram: { label: "系統図データ管理", desc: "④ 系統図の版の管理・系統図エディタ・使用中への切り替え（既存チェックリストへの影響の反映）", group: "管理" },
  rules: { label: "チェックリスト作成のルール", desc: "⑤ 仕切り方・各作業の設定・追加ルール・承認フローの設定", group: "管理" },
  equipment: { label: "機器マスター", desc: "機器マスターの追加・削除・取込", group: "管理" },
  users: { label: "ユーザー管理・権限の設定", desc: "利用者の作成・権限の付与・無効化と、この権限×機能の表の変更", group: "管理" },
};

/** 既定の権限×機能（DB に設定が無いときに使う。supabase/role_grants.sql の既定値と合わせること） */
export const DEFAULT_GRANTS: Record<Role, Permission[]> = {
  worker: ["create", "checklist", "qr"],
  approver: ["checklist", "qr", "approveLeader"],
  manager: ["checklist", "qr", "approveManager"],
  control: ["control", "approveControl"],
  // 外部ベンダー：ユーザー管理・権限の設定だけができない（それ以外はすべて）。拠点ごとに付ける
  vendor: ["create", "checklist", "qr", "approveLeader", "approveManager", "approveControl", "control", "diagram", "rules", "equipment"],
  // 作成（create）は付けない：作成者本人は承認できないため、作成は作業者、承認はそれ以外の人に分ける
  admin: ["checklist", "qr", "approveLeader", "approveManager", "approveControl", "control", "diagram", "rules", "equipment", "users"],
};

/** 外せない組み合わせ：管理者のユーザー管理（誰も権限を直せなくなるのを防ぐ） */
export const LOCKED_GRANTS: Partial<Record<Role, Permission[]>> = { admin: ["users"] };

/** 付けられない組み合わせ：外部ベンダーのユーザー管理・権限の設定 */
export const FORBIDDEN_GRANTS: Partial<Record<Role, Permission[]>> = { vendor: ["users"] };

/** 承認のお知らせメールの宛先・権限不足の案内で、通常の担当として扱わないロール */
export const BACKSTAGE_ROLES: Role[] = ["admin", "vendor"];

export type Grants = Record<Role, Permission[]>;

/** 保存値を権限×機能の表にそろえる（知らない値は捨て、外せない組み合わせは必ず入れる）。形が違えば null */
export function parseGrants(raw: unknown): Grants | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out = {} as Grants;
  for (const r of ROLES) {
    const v = obj[r];
    const list = Array.isArray(v) ? PERMISSIONS.filter((p) => v.includes(p)) : [...DEFAULT_GRANTS[r]];
    (LOCKED_GRANTS[r] ?? []).forEach((p) => !list.includes(p) && list.push(p));
    out[r] = PERMISSIONS.filter((p) => list.includes(p) && !FORBIDDEN_GRANTS[r]?.includes(p));
  }
  return out;
}

// 今使っている表。サーバーは DB から読み込んだ表（serverAuth.ts）、画面は /api/me で受け取った表を入れる
let grants: Grants = DEFAULT_GRANTS;
export const currentGrants = () => grants;
export function setGrants(g: Grants | null | undefined) {
  grants = g ?? DEFAULT_GRANTS;
}

/** ロールの説明（表から作る） */
export const roleDesc = (r: Role, g: Grants = grants) => g[r].map((p) => PERMISSION_INFO[p].label).join("・") || "なし";

/** その機能を使えるロール */
export const rolesWith = (perm: Permission, g: Grants = grants) => ROLES.filter((r) => g[r].includes(perm));

/** 保存値をロールの一覧にそろえる（知らない値は捨てる）。未設定なら null */
export function parseRoles(raw: unknown): Role[] | null {
  if (!Array.isArray(raw)) return null;
  return ROLES.filter((r) => raw.includes(r));
}

export function permissionsOf(roles: readonly Role[], g: Grants = grants): Set<Permission> {
  return new Set(roles.flatMap((r) => g[r] ?? []));
}

/** いずれかの機能を使えれば true */
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
  { prefix: "/admin", perms: ["users"] },
  // 既存系
  { prefix: "/equipment/print", perms: ["qr"] },
  { prefix: "/equipment", perms: ["equipment"] },
  { prefix: "/checklists", perms: ["checklist"] },
  { prefix: "/inspect", perms: ["checklist"] },
  { prefix: "/control-room", perms: ["control"] },
  // 配管系統図系
  // ① は作成（作業者）と承認（チームリーダー・G長・制御室）の両方で開く
  { prefix: "/piping/planner", perms: ["create", "approveLeader", "approveManager", "approveControl"] },
  { prefix: "/piping/field", perms: ["checklist"] },
  { prefix: "/piping/control", perms: ["control"] },
  { prefix: "/piping/qr", perms: ["qr"] },
  { prefix: "/piping/data", perms: ["diagram"] },
  { prefix: "/piping/editor", perms: ["diagram"] },
  { prefix: "/piping/rules", perms: ["rules"] },
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
  // 当日の運用によるタンク・ポンプ・充填元の入力は制御室だけ。工程の完了報告は現場（本人）と制御室
  setDayParams: ["control"],
  setFillSupply: ["control"],
  markStepDone: ["checklist", "control"],
  // 点検の開始の承認・お断り（制御室）
  approveStart: ["control"],
  rejectStart: ["control"],
  // 承認・差し戻し（どの段を承認できるかは /api/piping の中で確かめる。制御室の段は ③ で行う）
  approvePlan: ["approveLeader", "approveManager", "approveControl"],
  rejectPlan: ["approveLeader", "approveManager", "approveControl"],
  // 制御室
  confirm: ["control"],
  setOutage: ["control"],
  clearOutages: ["control"],
  setOperations: ["control"],
  setValve: ["control"],
  clearValveOverrides: ["control"],
  setOutageDefs: ["control"],
  // 管理
  setRules: ["rules"],
  // 系統図の版の切り替えに合わせたチェックリストの更新・差し戻し（版の切り替えと同じ機能）
  applyDiagramImpact: ["diagram"],
};

/** 権限が足りないときの案内文 */
export function deniedMessage(perms: Permission[]) {
  const roles = ROLES.filter((r) => perms.some((p) => grants[r].includes(p) && !BACKSTAGE_ROLES.includes(r)));
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
  if (can(access.roles, "control")) return "view";
  return "none";
}
