"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { normalizeUid } from "./nfcUid";

// Android Chrome の Web NFC（NDEFReader）で NFC タグ（NTAG215）の UID を読み取るフック。
// UID は NDEFReadingEvent.serialNumber から取る。NDEF レコードの中身は UID として使わない（records は無視）。
// iOS / iPadOS / デスクトップは非対応。Web NFC は HTTPS かつ画面の前面でのみ動く。

// ---- Web NFC の最小限の型（lib.dom に無いのでここで宣言。グローバルは汚さない） ----

type NDEFReadingEvent = Event & {
  /** タグの UID（例 "04:39:b5:1b:d5:2a:81"）。取得できないときは空文字 */
  readonly serialNumber: string;
};

type NDEFReader = EventTarget & {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
};

type NDEFReaderConstructor = new () => NDEFReader;

function getNdefReaderCtor(): NDEFReaderConstructor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { NDEFReader?: NDEFReaderConstructor }).NDEFReader;
  return typeof ctor === "function" ? ctor : null;
}

// ---- 公開する型・関数 ----

export type NfcSupport = "supported" | "unsupported" | "insecure";
export type NfcStatus = "idle" | "starting" | "scanning" | "error";

/** ブラウザが Web NFC を使えるか（SSR では "unsupported"）。insecure = HTTPS でない */
export function nfcSupport(): NfcSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return getNdefReaderCtor() ? "supported" : "unsupported";
}

/** 非対応時の日本語の案内文（supported なら null） */
export function nfcSupportMessage(s: NfcSupport): string | null {
  if (s === "supported") return null;
  if (s === "insecure") {
    return "NFC は HTTPS で開いたページでしか使えません。https:// から始まるアドレスでアプリを開き直してください。";
  }
  return "この端末・ブラウザでは NFC の読み取りに対応していません。NFC 搭載の Android 端末の Chrome で開いてください（iPhone・iPad・パソコンは非対応です）。";
}

// ---- エラーメッセージ ----

const MSG_NO_UID =
  "このタグの UID を取得できませんでした。タグを端末の背面（NFC アンテナ位置）に当て直してください。それでも取得できない場合は、別のタグでお試しください。";
const MSG_READ_ERROR =
  "タグを読み取れませんでした。タグを端末の背面（NFC アンテナ位置）にしっかり当て直してください。NDEF 形式に未フォーマットのタグでも、このエラーになることがあります。";
const MSG_NOT_ALLOWED =
  "NFC の使用が許可されていません。ブラウザのアドレスバー左のアイコンから「サイトの設定」を開き、NFC を「許可」にしてからもう一度お試しください。";
const MSG_NOT_SUPPORTED =
  "この端末では NFC を使えません。NFC が搭載されていないか、OFF になっています。Android の設定で NFC を ON にしてからもう一度お試しください。";
const MSG_NOT_READABLE =
  "NFC を読み取れる状態ではありません。Android の設定で NFC が ON か確認し、他のアプリが NFC を使っていないことを確かめてからもう一度お試しください。";

function scanErrorMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError") return MSG_NOT_ALLOWED;
  if (name === "NotSupportedError") return MSG_NOT_SUPPORTED;
  if (name === "NotReadableError") return MSG_NOT_READABLE;
  const detail = e instanceof Error && e.message ? `（${e.message}）` : "";
  return `NFC の読み取りを開始できませんでした${detail}。画面を開き直して、もう一度お試しください。`;
}

// ---- フック ----

// 判定はブラウザでしかできないので、サーバー描画（hydration）では "unsupported" として扱う
const subscribeNoop = () => () => {};
const getServerSupport = (): NfcSupport => "unsupported";

export function useNfcReader(
  onUid: (uid: string) => void,
  opts?: { dedupeMs?: number } // 同一 UID を無視する時間。既定 2500ms
): {
  support: NfcSupport;
  status: NfcStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
} {
  const dedupeMs = opts?.dedupeMs ?? 2500;
  const support = useSyncExternalStore(subscribeNoop, nfcSupport, getServerSupport);
  const [status, setStatus] = useState<NfcStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // 常に最新の関数を呼ぶ（stale closure 対策）
  const onUidRef = useRef(onUid);
  const dedupeRef = useRef(dedupeMs);
  useEffect(() => {
    onUidRef.current = onUid;
    dedupeRef.current = dedupeMs;
  });

  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef<NfcStatus>("idle");
  const lastRef = useRef<{ uid: string; at: number } | null>(null);

  const changeStatus = useCallback((s: NfcStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    lastRef.current = null;
    changeStatus("idle");
  }, [changeStatus]);

  const start = useCallback(async () => {
    if (statusRef.current === "scanning" || statusRef.current === "starting") return;
    const Ctor = getNdefReaderCtor();
    const s = nfcSupport();
    if (!Ctor || s !== "supported") {
      setError(nfcSupportMessage(s));
      changeStatus("error");
      return;
    }
    setError(null);
    changeStatus("starting");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const reader = new Ctor();
      reader.addEventListener("reading", (ev) => {
        if (controller.signal.aborted) return;
        // records（NDEF の中身）は使わない。UID は serialNumber だけ
        const serial = (ev as NDEFReadingEvent).serialNumber;
        if (!serial) {
          setError(MSG_NO_UID);
          return;
        }
        const uid = normalizeUid(serial);
        if (!uid) {
          setError(MSG_NO_UID);
          return;
        }
        const now = Date.now();
        const last = lastRef.current;
        if (last && last.uid === uid && now - last.at < dedupeRef.current) return;
        lastRef.current = { uid, at: now };
        setError(null);
        onUidRef.current(uid);
      });
      reader.addEventListener("readingerror", () => {
        if (controller.signal.aborted) return;
        setError(MSG_READ_ERROR);
      });
      await reader.scan({ signal: controller.signal });
      if (controller.signal.aborted) return;
      changeStatus("scanning");
    } catch (e) {
      if (controller.signal.aborted) return; // stop() による中断はエラーにしない
      abortRef.current = null;
      setError(scanErrorMessage(e));
      changeStatus("error");
    }
  }, [changeStatus]);

  // 画面が裏に回ったら止める（Web NFC は前面でのみ動く）。アンマウント時も止める
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && abortRef.current) stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [stop]);

  return { support, status, error, start, stop };
}
