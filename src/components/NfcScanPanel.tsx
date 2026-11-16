"use client";

import { useEffect, useRef, useState } from "react";
import { resolveNfcUid, tagLabel } from "@/lib/identifiers";
import { formatUid } from "@/lib/nfcUid";
import { nfcSupportMessage, useNfcReader } from "@/lib/useNfcReader";

// NFC タグの UID から機器番号を決め、onCode に渡す共通パネル。
// 機器番号が決まった後の処理（記録など）は呼び出し側の既存のQR読取処理に任せる。

type Props = {
  onCode: (code: string) => void;
  nameOf?: (code: string) => string | undefined;
  /** false のときは読取を無視する（ダイアログ表示中など） */
  canAccept?: () => boolean;
  /** 点検へ進めない読取のとき（NG ビープ用） */
  onReject?: () => void;
};

type Last = { ok: true; text: string } | { ok: false; text: string };

export default function NfcScanPanel({ onCode, nameOf, canAccept, onReject }: Props) {
  const [last, setLast] = useState<Last | null>(null);
  const busyRef = useRef(false);
  // 最新の props を参照する（stale closure 対策）
  const propsRef = useRef({ onCode, nameOf, canAccept, onReject });
  useEffect(() => {
    propsRef.current = { onCode, nameOf, canAccept, onReject };
  });

  async function handleUid(uid: string) {
    const p = propsRef.current;
    if (busyRef.current) return;
    if (p.canAccept && !p.canAccept()) return;
    busyRef.current = true;
    try {
      const r = await resolveNfcUid(uid);
      if (r.kind === "ok") {
        const name = propsRef.current.nameOf?.(r.code);
        setLast({
          ok: true,
          text: `${tagLabel(r.tag)} → 機器番号 ${r.code}${name ? `（${name}）` : ""}`,
        });
        propsRef.current.onCode(r.code);
      } else {
        setLast({ ok: false, text: `${r.message}（UID ${formatUid(uid)}）` });
        propsRef.current.onReject?.();
      }
    } catch {
      setLast({ ok: false, text: "NFCタグの確認中にエラーが発生しました。もう一度かざしてください。" });
      propsRef.current.onReject?.();
    } finally {
      busyRef.current = false;
    }
  }

  const { support, status, error, start, stop } = useNfcReader((uid) => {
    void handleUid(uid);
  });

  const supported = support === "supported";
  const active = status === "scanning" || status === "starting";
  const unsupportedMsg = nfcSupportMessage(support);

  return (
    <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-900 dark:bg-indigo-950/30">
      <button
        type="button"
        disabled={!supported}
        onClick={active ? stop : () => void start()}
        className={`w-full rounded-lg py-3 text-base font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
          active
            ? "border border-indigo-300 bg-white text-indigo-700 dark:border-indigo-700 dark:bg-zinc-950 dark:text-indigo-300"
            : "bg-indigo-600 text-white hover:bg-indigo-500"
        }`}
      >
        {active ? "NFC読取を停止" : "📶 NFCで読み取る"}
      </button>

      {!supported && (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span className="font-semibold">この端末ではNFCを利用できません。</span>
          {unsupportedMsg}
        </p>
      )}

      {supported && status === "starting" && (
        <p className="mt-2 text-center text-sm text-zinc-500">NFCを起動しています…</p>
      )}
      {supported && status === "scanning" && (
        <div className="mt-3 flex flex-col items-center gap-2 py-1">
          <span className="relative flex h-10 w-10 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-60" />
            <span className="relative text-xl">📶</span>
          </span>
          <p className="text-sm font-medium text-indigo-800 dark:text-indigo-300">
            NFCタグを端末の背面にかざしてください
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {last && (
        <p
          className={`mt-2 rounded-lg p-2 text-sm ${
            last.ok
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
          }`}
        >
          {last.text}
        </p>
      )}
    </div>
  );
}
