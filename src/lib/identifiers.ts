// QR・NFC 共通の設備識別。
// QR は今までどおり中身の機器番号（/inspect/{機器番号}）がそのまま識別値。
// NFC は UID を equipment_identifiers で機器番号に置き換える。機器番号が決まった後は、
// 既存の読取処理（/inspect の handleScan、/piping/field の handleCode）をそのまま使う。
// テーブルは supabase/equipment_identifiers.sql。

import { supabase } from "./supabase";
import { normalizeUid, parseUid } from "./nfcUid";

export type IdentifierType = "QR" | "NFC";
export type IdentifierStatus = "ACTIVE" | "DISABLED";

export type IdentifierRow = {
  id: string;
  identifier_type: IdentifierType;
  identifier_value: string;
  equipment_code: string | null;
  display_number: number | null;
  status: IdentifierStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

const TABLE = "equipment_identifiers";
const COLUMNS = "id, identifier_type, identifier_value, equipment_code, display_number, status, note, created_at, updated_at, updated_by";

/** テーブルが未作成のときの案内 */
export const MISSING_TABLE_MESSAGE =
  "NFC タグの管理テーブルがありません。supabase/equipment_identifiers.sql を Supabase の SQL Editor で実行してください。";

type PgError = { code?: string; message: string; details?: string | null } | null;

function isMissingTable(e: PgError) {
  return !!e && (e.code === "42P01" || e.code === "PGRST205" || /equipment_identifiers/.test(e.message) && /does not exist|schema cache/.test(e.message));
}

function dbError(e: NonNullable<PgError>): Error {
  if (isMissingTable(e)) return new Error(MISSING_TABLE_MESSAGE);
  if (e.code === "42501")
    return new Error(
      `NFC タグのデータを読み書きする権限がありません。テーブルの権限（supabase/equipment_identifiers.sql の grant）と、` +
        `利用者の権限（登録・変更は QR コード印刷の権限か管理者）を確認し、ログインし直してください。（${e.message}）`
    );
  return new Error(e.message);
}

// ───────────── 読取（現場） ─────────────

export type NfcResolution =
  | { kind: "ok"; code: string; tag: IdentifierRow }
  | { kind: "invalid"; message: string }
  | { kind: "unregistered"; uid: string; message: string }
  | { kind: "disabled"; tag: IdentifierRow; message: string }
  | { kind: "unassigned"; tag: IdentifierRow; message: string }
  | { kind: "error"; message: string };

/** タグの呼び名（管理番号があれば「タグ No.3」） */
export function tagLabel(tag: Pick<IdentifierRow, "display_number">) {
  return tag.display_number != null ? `タグ No.${tag.display_number}` : "NFC タグ";
}

/**
 * 読み取った UID から機器番号を決める。ok 以外は点検画面へ進めない（message を表示する）。
 * 無効化されたタグ・未割当のタグは点検に使えない。
 */
export async function resolveNfcUid(raw: string): Promise<NfcResolution> {
  const p = parseUid(raw);
  if (!p.ok) return { kind: "invalid", message: `読み取った UID の形式が正しくありません：${p.error}` };
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("identifier_type", "NFC")
    .eq("identifier_value", p.uid)
    .maybeSingle();
  if (error) return { kind: "error", message: dbError(error).message };
  const tag = data as IdentifierRow | null;
  if (!tag) return { kind: "unregistered", uid: p.uid, message: "未登録のNFCタグです" };
  if (tag.status !== "ACTIVE")
    return { kind: "disabled", tag, message: `${tagLabel(tag)} は無効化されています。点検には使えません。` };
  if (!tag.equipment_code)
    return { kind: "unassigned", tag, message: `${tagLabel(tag)} は機器に紐付けられていません。QR 発行画面で紐付けてください。` };
  return { kind: "ok", code: tag.equipment_code, tag };
}

// ───────────── 管理（QR 発行画面） ─────────────

export async function listNfcTags(): Promise<IdentifierRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("identifier_type", "NFC")
    .order("display_number", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) throw dbError(error);
  return (data ?? []) as IdentifierRow[];
}

export async function findNfcTag(uid: string): Promise<IdentifierRow | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("identifier_type", "NFC")
    .eq("identifier_value", normalizeUid(uid))
    .maybeSingle();
  if (error) throw dbError(error);
  return (data as IdentifierRow | null) ?? null;
}

/** 重複したときに、相手の登録情報を添えて返すエラー */
export class IdentifierConflictError extends Error {
  constructor(message: string, readonly existing: IdentifierRow | null) {
    super(message);
  }
}

function describe(tag: IdentifierRow) {
  return `${tagLabel(tag)}（UID ${tag.identifier_value}、${tag.equipment_code ? `機器 ${tag.equipment_code}` : "未割当"}、${tag.status === "ACTIVE" ? "有効" : "無効"}）`;
}

/** 一意制約の違反を、どれと重複したかの説明に置き換える */
async function conflictError(e: NonNullable<PgError>, input: { uid?: string; code?: string | null; displayNumber?: number | null; selfId?: string }): Promise<Error> {
  if (e.code !== "23505") return dbError(e);
  const text = `${e.message} ${e.details ?? ""}`;
  const others = (await listNfcTags().catch(() => [])).filter((t) => t.id !== input.selfId);
  if (/type_value/.test(text) && input.uid) {
    const t = others.find((x) => x.identifier_value === input.uid) ?? null;
    return new IdentifierConflictError(`この UID はすでに登録されています${t ? `：${describe(t)}` : ""}`, t);
  }
  if (/per_code/.test(text) && input.code) {
    const t = others.find((x) => x.status === "ACTIVE" && x.equipment_code === input.code) ?? null;
    return new IdentifierConflictError(
      `機器 ${input.code} にはすでに有効な NFC タグがあります${t ? `：${describe(t)}` : ""}。タグ交換のときは先に旧タグを無効化してください。`,
      t
    );
  }
  if (/number/.test(text) && input.displayNumber != null) {
    const t = others.find((x) => x.status === "ACTIVE" && x.display_number === input.displayNumber) ?? null;
    return new IdentifierConflictError(`管理番号 ${input.displayNumber} はすでに使われています${t ? `：${describe(t)}` : ""}`, t);
  }
  return new IdentifierConflictError(`登録済みの情報と重複しています（${e.message}）`, null);
}

export type NfcTagInput = {
  uid: string; // 入力のまま（コロン有無どちらでも可）
  equipmentCode?: string | null;
  displayNumber?: number | null;
  note?: string | null;
};

function cleanCode(code: string | null | undefined) {
  const c = code?.trim();
  return c ? c : null;
}

/** NFC タグを登録する（UID の重複・形式は登録前とDBの両方で確かめる） */
export async function registerNfcTag(input: NfcTagInput, by: string): Promise<IdentifierRow> {
  const p = parseUid(input.uid);
  if (!p.ok) throw new Error(p.error);
  const existing = await findNfcTag(p.uid);
  if (existing) throw new IdentifierConflictError(`この UID はすでに登録されています：${describe(existing)}`, existing);
  const code = cleanCode(input.equipmentCode);
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      identifier_type: "NFC",
      identifier_value: p.uid,
      equipment_code: code,
      display_number: input.displayNumber ?? null,
      note: input.note?.trim() || null,
      status: "ACTIVE",
      updated_by: by,
    })
    .select(COLUMNS)
    .single();
  if (error) throw await conflictError(error, { uid: p.uid, code, displayNumber: input.displayNumber });
  return data as IdentifierRow;
}

export type NfcTagPatch = {
  equipmentCode?: string | null; // null で紐付け解除
  displayNumber?: number | null;
  status?: IdentifierStatus;
  note?: string | null;
};

/** 紐付け先・管理番号・状態を変える（UID は変えない。別の UID にするときは新しいタグとして登録する） */
export async function updateNfcTag(tag: IdentifierRow, patch: NfcTagPatch, by: string): Promise<IdentifierRow> {
  const row: Record<string, unknown> = { updated_by: by };
  if ("equipmentCode" in patch) row.equipment_code = cleanCode(patch.equipmentCode);
  if ("displayNumber" in patch) row.display_number = patch.displayNumber ?? null;
  if ("status" in patch) row.status = patch.status;
  if ("note" in patch) row.note = patch.note?.trim() || null;
  const { data, error } = await supabase.from(TABLE).update(row).eq("id", tag.id).select(COLUMNS).single();
  if (error)
    throw await conflictError(error, {
      code: (row.equipment_code as string | null | undefined) ?? tag.equipment_code,
      displayNumber: "displayNumber" in patch ? patch.displayNumber : tag.display_number,
      selfId: tag.id,
    });
  return data as IdentifierRow;
}

/**
 * タグ交換：旧タグを無効化し、新しい UID を同じ機器番号・管理番号で登録する。
 * 新タグの登録に失敗したら旧タグを有効に戻す（DB の関数を使わないため、ベストエフォート）。
 */
export async function replaceNfcTag(oldTag: IdentifierRow, newUid: string, by: string): Promise<IdentifierRow> {
  const p = parseUid(newUid);
  if (!p.ok) throw new Error(p.error);
  if (p.uid === oldTag.identifier_value) throw new Error("新しいタグの UID が旧タグと同じです");
  const dup = await findNfcTag(p.uid);
  if (dup) throw new IdentifierConflictError(`新しいタグの UID はすでに登録されています：${describe(dup)}`, dup);
  const wasActive = oldTag.status === "ACTIVE";
  if (wasActive) await updateNfcTag(oldTag, { status: "DISABLED" }, by);
  try {
    return await registerNfcTag(
      { uid: p.uid, equipmentCode: oldTag.equipment_code, displayNumber: oldTag.display_number, note: `${oldTag.identifier_value} から交換` },
      by
    );
  } catch (e) {
    if (wasActive) await updateNfcTag({ ...oldTag, status: "DISABLED" }, { status: "ACTIVE" }, by).catch(() => {});
    throw e;
  }
}
