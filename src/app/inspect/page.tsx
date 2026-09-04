"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  clearActiveSession,
  ensureActiveSession,
  type InspectionSession,
} from "@/lib/inspectionSession";

export default function InspectScannerPage() {
  const router = useRouter();
  const [session, setSession] = useState<InspectionSession | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    ensureActiveSession().then(setSession);
    return () => {
      stopScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goToCode(rawText: string) {
    const text = rawText.trim();
    const marker = "/inspect/";
    const idx = text.indexOf(marker);
    const code = idx >= 0 ? text.slice(idx + marker.length) : text;
    if (!code) return;
    router.push(`/inspect/${encodeURIComponent(code)}`);
  }

  async function startScanner() {
    if (startingRef.current) return;
    startingRef.current = true;
    setCameraError(null);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          goToCode(decodedText);
          stopScanner();
        },
        undefined
      );
      setScanning(true);
    } catch {
      setCameraError(
        "カメラを起動できませんでした。ブラウザのカメラ許可設定を確認するか、下の欄に機器番号を直接入力してください。"
      );
    } finally {
      startingRef.current = false;
    }
  }

  function stopScanner() {
    const scanner = scannerRef.current;
    if (scanner) {
      scanner
        .stop()
        .then(() => scanner.clear())
        .catch(() => {});
      scannerRef.current = null;
    }
    setScanning(false);
  }

  async function startNewSession() {
    stopScanner();
    clearActiveSession();
    const next = await ensureActiveSession();
    setSession(next);
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-black">
      <div className="mx-auto max-w-md">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← ホームに戻る
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          現場チェック
        </h1>

        <div className="mt-4 flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div>
            <p className="text-zinc-500">実施中のセッション</p>
            <p className="font-medium text-zinc-900 dark:text-zinc-100">
              {session?.title ?? "準備中..."}
            </p>
          </div>
          <button
            onClick={startNewSession}
            className="text-emerald-700 hover:underline dark:text-emerald-400"
          >
            新しい点検を開始
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div id="qr-reader" className="overflow-hidden rounded-lg" />
          {!scanning && (
            <button
              onClick={startScanner}
              className="mt-4 w-full rounded-lg bg-zinc-900 py-3 text-base font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              カメラでQRコードを読み取る
            </button>
          )}
          {scanning && (
            <button
              onClick={stopScanner}
              className="mt-4 w-full rounded-lg border border-zinc-300 py-3 text-base font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            >
              スキャンを中止
            </button>
          )}
          {cameraError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{cameraError}</p>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            QRが読み取れない場合は機器番号を直接入力
          </p>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualCode.trim()) goToCode(manualCode);
              }}
              placeholder="例: V-1001"
              className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <button
              onClick={() => manualCode.trim() && goToCode(manualCode)}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              移動
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
