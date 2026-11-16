// NFC タグの UID（NTAG215：ISO 14443-3A、7 バイト）の正規化・検証。
// 保存値は 16 進大文字・区切り無し（例 04:39:B5:1B:D5:2A:81 → 0439B51BD52A81）。
// UID はタグの個体番号であり、NDEF に書き込んだデータではない。暗号学的な認証にも使わない。
// DB にも同じ形式の制約がある（supabase/equipment_identifiers.sql）。

export const NFC_UID_BYTES = 7;
const UID_RE = new RegExp(`^[0-9A-F]{${NFC_UID_BYTES * 2}}$`);

/** 区切り（コロン・ハイフン・空白）を除き、全角を半角に、英字を大文字にそろえる */
export function normalizeUid(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\s:\-]/g, "")
    .toUpperCase();
}

/** 正規化済み UID の形式を確かめる。問題なければ null、あれば理由 */
export function uidFormatError(uid: string): string | null {
  if (!uid) return "UID を入力してください";
  if (/[^0-9A-F]/.test(uid)) return "UID には 0〜9・A〜F（16進数）だけを使ってください";
  if (!UID_RE.test(uid)) return `UID は ${NFC_UID_BYTES} バイト（16進数 ${NFC_UID_BYTES * 2} 桁）です（入力は ${uid.length} 桁）`;
  return null;
}

/** 入力を正規化して検証する */
export function parseUid(raw: string): { ok: true; uid: string } | { ok: false; error: string } {
  const uid = normalizeUid(raw);
  const error = uidFormatError(uid);
  return error ? { ok: false, error } : { ok: true, uid };
}

/** 画面表示用（04:39:B5:1B:D5:2A:81） */
export function formatUid(uid: string): string {
  return uid.match(/.{1,2}/g)?.join(":") ?? uid;
}
