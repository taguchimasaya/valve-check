"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMe } from "@/lib/auth";
import {
  IdentifierConflictError,
  MISSING_TABLE_MESSAGE,
  findNfcTag,
  listNfcTags,
  registerNfcTag,
  replaceNfcTag,
  tagLabel,
  updateNfcTag,
  type IdentifierRow,
} from "@/lib/identifiers";
import { formatUid, normalizeUid, parseUid } from "@/lib/nfcUid";
import { nfcSupportMessage, useNfcReader, type NfcStatus, type NfcSupport } from "@/lib/useNfcReader";

// QR印刷画面の NFC タグ管理（UID と機器番号の紐付け）。画面表示専用で、印刷結果には出さない。
// NFC リーダー（useNfcReader）はプロバイダーで 1 つだけ起動し、使う側は owner を名乗って借りる。

export type NfcNodeInfo = { label: string; name: string; area: string };

type NfcCtx = {
  tags: IdentifierRow[] | null;
  loadError: string | null;
  missingTable: boolean;
  reload: () => Promise<void>;
  nodes: NfcNodeInfo[];
  by: string;
  canEdit: boolean;
  nameOf: (code: string | null) => string | null;
  activeByCode: Map<string, IdentifierRow>;
  reader: {
    support: NfcSupport;
    status: NfcStatus;
    error: string | null;
    owner: string | null;
    begin: (owner: string, handler: (uid: string) => void) => void;
    end: (owner: string) => void;
  };
};

const Ctx = createContext<NfcCtx | null>(null);

function useNfc(): NfcCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("NfcTagProvider の中で使ってください");
  return c;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const inputCls = "w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-sm disabled:bg-zinc-100";
const subBtn =
  "rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40";
const mainBtn = "rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40";
const dangerBtn =
  "rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40";

// ───────────── プロバイダー ─────────────

export function NfcTagProvider({ nodes, children }: { nodes: NfcNodeInfo[]; children: ReactNode }) {
  const me = useMe();
  const [tags, setTags] = useState<IdentifierRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const t = await listNfcTags();
      setTags(t);
      setLoadError(null);
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    let alive = true;
    listNfcTags().then(
      (t) => {
        if (!alive) return;
        setTags(t);
        setLoadError(null);
      },
      (e) => alive && setLoadError(errMsg(e))
    );
    return () => {
      alive = false;
    };
  }, []);

  // ---- 共有リーダー ----
  const handlerRef = useRef<((uid: string) => void) | null>(null);
  const ownerRef = useRef<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const reader = useNfcReader((uid) => handlerRef.current?.(uid));
  const { start, stop } = reader;

  const begin = useCallback(
    (o: string, handler: (uid: string) => void) => {
      if (ownerRef.current && ownerRef.current !== o) stop();
      ownerRef.current = o;
      handlerRef.current = handler;
      setOwner(o);
      void start();
    },
    [start, stop]
  );
  const end = useCallback(
    (o: string) => {
      if (ownerRef.current !== o) return;
      ownerRef.current = null;
      handlerRef.current = null;
      setOwner(null);
      stop();
    },
    [stop]
  );

  const nameMap = useMemo(() => new Map(nodes.map((n) => [n.label, n.name])), [nodes]);
  const nameOf = useCallback((code: string | null) => (code ? (nameMap.get(code) ?? null) : null), [nameMap]);
  const activeByCode = useMemo(() => {
    const m = new Map<string, IdentifierRow>();
    for (const t of tags ?? []) if (t.status === "ACTIVE" && t.equipment_code) m.set(t.equipment_code, t);
    return m;
  }, [tags]);

  const value: NfcCtx = {
    tags,
    loadError,
    missingTable: loadError === MISSING_TABLE_MESSAGE,
    reload,
    nodes,
    by: me?.name ?? "",
    canEdit: !!me,
    nameOf,
    activeByCode,
    reader: { support: reader.support, status: reader.status, error: reader.error, owner, begin, end },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ───────────── 共通部品 ─────────────

/** UID 入力欄（手入力 + NFC 読取）。owner はリーダーを借りる側の識別名 */
function UidField({ value, onChange, owner, disabled }: { value: string; onChange: (v: string) => void; owner: string; disabled?: boolean }) {
  const { reader } = useNfc();
  const { begin, end, support, status } = reader;
  useEffect(() => () => end(owner), [end, owner]);

  const parsed = value.trim() ? parseUid(value) : null;
  const mine = reader.owner === owner;
  const waiting = mine && (status === "starting" || status === "scanning");
  const supportMsg = nfcSupportMessage(support);

  const read = () =>
    begin(owner, (uid) => {
      onChange(formatUid(uid));
      end(owner);
    });

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="UID（例 04:39:B5:1B:D5:2A:81）"
          disabled={disabled}
          className={`${inputCls} font-mono`}
          spellCheck={false}
          autoCapitalize="characters"
        />
        {waiting ? (
          <button type="button" onClick={() => end(owner)} className={`${subBtn} shrink-0`}>
            中止
          </button>
        ) : (
          <button type="button" onClick={read} disabled={disabled || support !== "supported"} className={`${subBtn} shrink-0`}>
            NFCで読み取る
          </button>
        )}
      </div>
      {parsed && !parsed.ok && <p className="text-xs text-red-600">{parsed.error}</p>}
      {parsed?.ok && <p className="text-xs text-emerald-700">形式OK：{formatUid(parsed.uid)}</p>}
      {waiting && <p className="text-xs font-medium text-emerald-700">タグを端末の背面にかざしてください…</p>}
      {mine && reader.error && <p className="text-xs text-red-600">{reader.error}</p>}
      {supportMsg && <p className="text-xs text-zinc-500">{supportMsg}</p>}
    </div>
  );
}

/** 紐付け先機器の選択（未割当も可） */
function EquipmentSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const { nodes } = useNfc();
  const options = useMemo(() => {
    const seen = new Set<string>();
    return nodes.filter((n) => n.label && !seen.has(n.label) && seen.add(n.label));
  }, [nodes]);
  const known = !value || options.some((n) => n.label === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={inputCls}>
      <option value="">未割当</option>
      {!known && <option value={value}>{value}（この拠点の系統図に無い機器）</option>}
      {options.map((n) => (
        <option key={n.label} value={n.label}>
          {n.label}　{n.name}
        </option>
      ))}
    </select>
  );
}

function StatusBadge({ status }: { status: IdentifierRow["status"] }) {
  return status === "ACTIVE" ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">有効</span>
  ) : (
    <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-600">無効</span>
  );
}

/** 相手のタグの登録情報（重複時の表示） */
function TagSummary({ tag }: { tag: IdentifierRow }) {
  const { nameOf } = useNfc();
  const name = nameOf(tag.equipment_code);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-zinc-700">
      <dt className="text-zinc-500">管理番号</dt>
      <dd>{tag.display_number ?? "なし"}</dd>
      <dt className="text-zinc-500">機器番号</dt>
      <dd>{tag.equipment_code ?? "未割当"}</dd>
      <dt className="text-zinc-500">設備名称</dt>
      <dd>{tag.equipment_code ? (name ?? "この拠点の系統図に無い機器") : "-"}</dd>
      <dt className="text-zinc-500">UID</dt>
      <dd className="font-mono">{formatUid(tag.identifier_value)}</dd>
      <dt className="text-zinc-500">状態</dt>
      <dd>{tag.status === "ACTIVE" ? "有効" : "無効"}</dd>
    </dl>
  );
}

function ErrorBox({ message, existing }: { message: string; existing?: IdentifierRow | null }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
      <p>{message}</p>
      {existing && (
        <div className="rounded-md bg-white p-2">
          <TagSummary tag={existing} />
        </div>
      )}
    </div>
  );
}

type Failure = { message: string; existing: IdentifierRow | null };
function toFailure(e: unknown): Failure {
  return { message: errMsg(e), existing: e instanceof IdentifierConflictError ? e.existing : null };
}

function parseNumber(s: string): { ok: true; value: number | null } | { ok: false } {
  const t = s.trim();
  if (!t) return { ok: true, value: null };
  const half = t.normalize("NFKC");
  if (!/^\d{1,9}$/.test(half)) return { ok: false };
  return { ok: true, value: Number(half) };
}

// ───────────── 管理パネル ─────────────

type StatusFilter = "all" | "ACTIVE" | "DISABLED" | "unassigned";

export function NfcTagPanel() {
  const ctx = useNfc();
  const { tags, loadError, missingTable, nameOf } = ctx;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const list = useMemo(() => {
    const q = search.normalize("NFKC").toLowerCase().trim();
    const qUid = normalizeUid(search);
    return (tags ?? []).filter((t) => {
      if (statusFilter === "ACTIVE" && t.status !== "ACTIVE") return false;
      if (statusFilter === "DISABLED" && t.status !== "DISABLED") return false;
      if (statusFilter === "unassigned" && t.equipment_code) return false;
      if (!q) return true;
      const name = nameOf(t.equipment_code) ?? "";
      return (
        (t.display_number != null && String(t.display_number).includes(q)) ||
        name.normalize("NFKC").toLowerCase().includes(q) ||
        (t.equipment_code ?? "").normalize("NFKC").toLowerCase().includes(q) ||
        (qUid !== "" && t.identifier_value.includes(qUid))
      );
    });
  }, [tags, search, statusFilter, nameOf]);

  return (
    <section className="mt-4 rounded-xl border border-zinc-200 text-sm print:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="font-semibold text-zinc-900">
          NFCタグ管理{tags ? `（${tags.length}枚）` : ""}
        </span>
        <span className="text-xs text-zinc-500">{open ? "閉じる ▲" : "開く ▼"}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-zinc-200 p-4">
          {missingTable && <ErrorBox message={MISSING_TABLE_MESSAGE} />}
          {loadError && !missingTable && <ErrorBox message={loadError} />}
          {!tags && !loadError && <p className="text-xs text-zinc-500">読み込み中…</p>}
          {tags && (
            <>
              <p className="text-xs text-zinc-500">
                タグの UID を機器番号（QR の中身と同じ）に紐付けます。タグは削除できず、無効化のみです。
                UID は全体で一意、有効なタグは 1 機器 1 枚です。
              </p>
              <RegisterForm />

              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-48 flex-1 space-y-1">
                  <span className="block text-xs text-zinc-500">検索</span>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="管理番号・設備名称・UID・機器番号"
                    className={inputCls}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-zinc-500">状態</span>
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className={inputCls}>
                    <option value="all">すべて</option>
                    <option value="ACTIVE">有効</option>
                    <option value="DISABLED">無効</option>
                    <option value="unassigned">未割当</option>
                  </select>
                </label>
              </div>

              <div className="rounded-lg border border-zinc-200">
                <div className="hidden grid-cols-[4rem_7rem_1fr_11rem_4.5rem_6rem] gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-500 md:grid">
                  <span>管理番号</span>
                  <span>機器番号</span>
                  <span>設備名称</span>
                  <span>UID</span>
                  <span>状態</span>
                  <span>操作</span>
                </div>
                {list.map((t) => (
                  <TagRow key={t.id} tag={t} />
                ))}
                {list.length === 0 && <p className="p-4 text-center text-xs text-zinc-500">該当するNFCタグがありません。</p>}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function RegisterForm() {
  const { by, canEdit, reload, nameOf } = useNfc();
  const [uid, setUid] = useState("");
  const [code, setCode] = useState("");
  const [num, setNum] = useState("");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const parsedUid = parseUid(uid);
  const parsedNum = parseNumber(num);
  const canSubmit = canEdit && !busy && parsedUid.ok && parsedNum.ok;

  const submit = async () => {
    if (!parsedUid.ok || !parsedNum.ok) return;
    setBusy(true);
    setFail(null);
    setDone(null);
    try {
      const dup = await findNfcTag(parsedUid.uid);
      if (dup) {
        setFail({ message: "この UID はすでに登録されているため、登録できません。", existing: dup });
        return;
      }
      const row = await registerNfcTag({ uid: parsedUid.uid, equipmentCode: code || null, displayNumber: parsedNum.value }, by);
      setDone(
        `${tagLabel(row)}（${formatUid(row.identifier_value)}）を登録しました${row.equipment_code ? `：${row.equipment_code} ${nameOf(row.equipment_code) ?? ""}` : "（未割当）"}`
      );
      setUid("");
      setCode("");
      setNum("");
      await reload();
    } catch (e) {
      setFail(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg bg-zinc-50 p-3">
      <h3 className="text-xs font-semibold text-zinc-700">新規登録</h3>
      <UidField value={uid} onChange={setUid} owner="register" disabled={busy} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-xs text-zinc-500">紐付け先機器（任意）</span>
          <EquipmentSelect value={code} onChange={setCode} disabled={busy} />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-zinc-500">管理番号（任意・整数）</span>
          <input
            inputMode="numeric"
            value={num}
            onChange={(e) => setNum(e.target.value)}
            disabled={busy}
            placeholder="例 3"
            className={inputCls}
          />
          {!parsedNum.ok && <span className="block text-xs text-red-600">管理番号は整数で入力してください</span>}
        </label>
      </div>
      <button type="button" onClick={submit} disabled={!canSubmit} className={mainBtn}>
        {busy ? "登録中…" : "登録する"}
      </button>
      {fail && <ErrorBox message={fail.message} existing={fail.existing} />}
      {done && <p className="text-xs text-emerald-700">{done}</p>}
    </div>
  );
}

function TagRow({ tag }: { tag: IdentifierRow }) {
  const { by, canEdit, reload, nameOf } = useNfc();
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState("");
  const [num, setNum] = useState("");
  const [newUid, setNewUid] = useState("");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const name = nameOf(tag.equipment_code);
  const owner = `row-${tag.id}`;

  const toggle = () => {
    if (!editing) {
      setCode(tag.equipment_code ?? "");
      setNum(tag.display_number != null ? String(tag.display_number) : "");
      setNewUid("");
      setFail(null);
      setDone(null);
    }
    setEditing(!editing);
  };

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setFail(null);
    setDone(null);
    try {
      const msg = await fn();
      await reload();
      setDone(msg);
    } catch (e) {
      setFail(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  const parsedNum = parseNumber(num);

  const save = () =>
    run(async () => {
      if (!parsedNum.ok) throw new Error("管理番号は整数で入力してください");
      const patch: { equipmentCode?: string | null; displayNumber?: number | null } = {};
      if ((code || null) !== tag.equipment_code) patch.equipmentCode = code || null;
      if (parsedNum.value !== tag.display_number) patch.displayNumber = parsedNum.value;
      if (Object.keys(patch).length === 0) return "変更はありません";
      await updateNfcTag(tag, patch, by);
      return "保存しました";
    });

  const setStatus = (status: "ACTIVE" | "DISABLED") => {
    if (status === "DISABLED" && !window.confirm(`${tagLabel(tag)}（${formatUid(tag.identifier_value)}）を無効化します。よろしいですか？`)) return;
    void run(async () => {
      await updateNfcTag(tag, { status }, by);
      return status === "ACTIVE" ? "有効に戻しました" : "無効化しました";
    });
  };

  const replace = () => {
    const p = parseUid(newUid);
    if (!p.ok) return;
    if (!window.confirm(`旧タグを無効化し、新しい UID ${formatUid(p.uid)} を同じ機器・管理番号で登録します。よろしいですか？`)) return;
    void run(async () => {
      await replaceNfcTag(tag, p.uid, by);
      return "タグを交換しました";
    });
  };

  return (
    <div className="border-b border-zinc-100 px-3 py-2.5 last:border-b-0">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm md:grid-cols-[4rem_7rem_1fr_11rem_4.5rem_6rem] md:items-center md:gap-2">
        <div>
          <span className="text-xs text-zinc-500 md:hidden">管理番号　</span>
          <span className="font-semibold text-zinc-900">{tag.display_number ?? "-"}</span>
        </div>
        <div className="break-all">
          <span className="text-xs text-zinc-500 md:hidden">機器番号　</span>
          {tag.equipment_code ?? <span className="text-zinc-400">未割当</span>}
        </div>
        <div className="col-span-2 md:col-span-1">
          <span className="text-xs text-zinc-500 md:hidden">設備名称　</span>
          {tag.equipment_code ? (
            name ?? <span className="text-zinc-400">この拠点の系統図に無い機器</span>
          ) : (
            <span className="text-zinc-400">-</span>
          )}
        </div>
        <div className="col-span-2 break-all font-mono text-xs text-zinc-700 md:col-span-1">{formatUid(tag.identifier_value)}</div>
        <div>
          <StatusBadge status={tag.status} />
        </div>
        <div className="text-right md:text-left">
          <button type="button" onClick={toggle} className={subBtn}>
            {editing ? "閉じる" : "操作"}
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-3 rounded-lg bg-zinc-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="block text-xs text-zinc-500">紐付け先機器（未割当で解除）</span>
              <EquipmentSelect value={code} onChange={setCode} disabled={busy} />
            </label>
            <label className="space-y-1">
              <span className="block text-xs text-zinc-500">管理番号</span>
              <input inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value)} disabled={busy} className={inputCls} />
              {!parsedNum.ok && <span className="block text-xs text-red-600">管理番号は整数で入力してください</span>}
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={save} disabled={busy || !canEdit || !parsedNum.ok} className={mainBtn}>
              {busy ? "保存中…" : "紐付け・管理番号を保存"}
            </button>
            {tag.status === "ACTIVE" ? (
              <button type="button" onClick={() => setStatus("DISABLED")} disabled={busy || !canEdit} className={dangerBtn}>
                無効化
              </button>
            ) : (
              <button type="button" onClick={() => setStatus("ACTIVE")} disabled={busy || !canEdit} className={subBtn}>
                有効に戻す
              </button>
            )}
          </div>

          <div className="space-y-2 border-t border-zinc-200 pt-3">
            <h4 className="text-xs font-semibold text-zinc-700">タグ交換（新しい UID に置き換え）</h4>
            <UidField value={newUid} onChange={setNewUid} owner={owner} disabled={busy} />
            <button type="button" onClick={replace} disabled={busy || !canEdit || !parseUid(newUid).ok} className={subBtn}>
              このタグに交換
            </button>
          </div>
          {fail && <ErrorBox message={fail.message} existing={fail.existing} />}
          {done && <p className="text-xs text-emerald-700">{done}</p>}
        </div>
      )}
    </div>
  );
}

// ───────────── QR カード側 ─────────────

/** QRカードの画面表示専用部分（印刷しない）：紐付き状況と紐付けボタン */
export function NfcCardInfo({ code }: { code: string }) {
  const { tags, activeByCode } = useNfc();
  const [open, setOpen] = useState(false);
  if (!tags) return null; // テーブル未作成・読込前は何も出さない
  const tag = activeByCode.get(code);
  return (
    <div className="mt-2 space-y-1 print:hidden">
      {tag ? (
        <div className="text-[10px] leading-tight text-zinc-600">
          <p className="font-semibold text-emerald-700">{tag.display_number != null ? `NFC No.${tag.display_number}` : "NFC"}</p>
          <p className="font-mono break-all text-zinc-400">{formatUid(tag.identifier_value)}</p>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-400">NFC未登録</p>
      )}
      <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-50">
        {tag ? "付け替え" : "紐付け"}
      </button>
      {open && <LinkDialog code={code} current={tag ?? null} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LinkDialog({ code, current, onClose }: { code: string; current: IdentifierRow | null; onClose: () => void }) {
  const { tags, by, canEdit, reload, nameOf } = useNfc();
  const [pick, setPick] = useState("");
  const [uid, setUid] = useState("");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [moveFrom, setMoveFrom] = useState<IdentifierRow | null>(null);

  const free = useMemo(
    () =>
      (tags ?? [])
        .filter((t) => t.status === "ACTIVE" && !t.equipment_code)
        .sort((a, b) => (a.display_number ?? Infinity) - (b.display_number ?? Infinity)),
    [tags]
  );

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setFail(null);
    setDone(null);
    try {
      setDone(await fn());
      await reload();
    } catch (e) {
      setFail(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  const assignPicked = () => {
    const t = free.find((x) => x.id === pick);
    if (!t) return;
    void run(async () => {
      await updateNfcTag(t, { equipmentCode: code }, by);
      setPick("");
      return `${tagLabel(t)} を ${code} に紐付けました`;
    });
  };

  const linkUid = () => {
    const p = parseUid(uid);
    if (!p.ok) return;
    setMoveFrom(null);
    void run(async () => {
      const found = await findNfcTag(p.uid);
      if (!found) {
        const row = await registerNfcTag({ uid: p.uid, equipmentCode: code }, by);
        setUid("");
        return `新規登録して ${code} に紐付けました（${formatUid(row.identifier_value)}）`;
      }
      if (found.status !== "ACTIVE") throw new Error("このタグは無効化されています。NFCタグ管理で有効に戻してから紐付けてください。");
      if (found.equipment_code === code) throw new Error("このタグはすでにこの機器に紐付いています。");
      if (found.equipment_code) {
        setMoveFrom(found); // 付け替えの確認待ち
        return "";
      }
      await updateNfcTag(found, { equipmentCode: code }, by);
      setUid("");
      return `${tagLabel(found)} を ${code} に紐付けました`;
    });
  };

  const move = () => {
    if (!moveFrom) return;
    const from = moveFrom;
    void run(async () => {
      await updateNfcTag(from, { equipmentCode: code }, by);
      setMoveFrom(null);
      setUid("");
      return `${tagLabel(from)} を ${from.equipment_code} から ${code} へ付け替えました`;
    });
  };

  const release = () => {
    if (!current) return;
    if (!window.confirm(`${code} とタグ（${formatUid(current.identifier_value)}）の紐付けを解除します。よろしいですか？`)) return;
    void run(async () => {
      await updateNfcTag(current, { equipmentCode: null }, by);
      return "紐付けを解除しました";
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden" role="dialog" aria-modal="true">
      <div className="max-h-full w-full max-w-md space-y-4 overflow-y-auto rounded-xl bg-white p-4 text-left shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">NFCタグの紐付け</h3>
            <p className="text-xs text-zinc-500">
              {code}　{nameOf(code) ?? ""}
            </p>
          </div>
          <button type="button" onClick={onClose} className={subBtn}>
            閉じる
          </button>
        </div>

        {current && (
          <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
            <p className="text-xs text-zinc-600">
              現在：{tagLabel(current)}（<span className="font-mono">{formatUid(current.identifier_value)}</span>）
            </p>
            <button type="button" onClick={release} disabled={busy || !canEdit} className={dangerBtn}>
              紐付けを解除
            </button>
            <p className="text-[11px] text-zinc-500">別のタグに替えるときは、先に解除するか、NFCタグ管理の「タグ交換」を使ってください。</p>
          </div>
        )}

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-zinc-700">未割当のタグから選ぶ</h4>
          {free.length === 0 ? (
            <p className="text-xs text-zinc-500">未割当の有効なタグはありません。</p>
          ) : (
            <div className="flex gap-2">
              <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy} className={inputCls}>
                <option value="">タグを選択</option>
                {free.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.display_number != null ? `No.${t.display_number}` : "番号なし"}　{formatUid(t.identifier_value)}
                  </option>
                ))}
              </select>
              <button type="button" onClick={assignPicked} disabled={busy || !canEdit || !pick} className={`${mainBtn} shrink-0`}>
                割り当て
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-zinc-700">UID を入力・読み取る</h4>
          <UidField
            value={uid}
            onChange={(v) => {
              setUid(v);
              setMoveFrom(null);
            }}
            owner={`dialog-${code}`}
            disabled={busy}
          />
          <button type="button" onClick={linkUid} disabled={busy || !canEdit || !parseUid(uid).ok} className={mainBtn}>
            {busy ? "処理中…" : "この機器に紐付ける"}
          </button>
        </div>

        {moveFrom && (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs text-amber-800">このタグは別の機器に紐付いています。付け替えると、元の機器の紐付けは外れます。</p>
            <div className="rounded-md bg-white p-2">
              <TagSummary tag={moveFrom} />
            </div>
            <button type="button" onClick={move} disabled={busy || !canEdit} className={mainBtn}>
              この機器へ付け替える
            </button>
          </div>
        )}

        {fail && <ErrorBox message={fail.message} existing={fail.existing} />}
        {done && <p className="text-xs text-emerald-700">{done}</p>}
      </div>
    </div>
  );
}
