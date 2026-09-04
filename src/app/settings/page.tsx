"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  isStepCompleteAudioEnabled,
  isValveActionAudioEnabled,
  setStepCompleteAudioEnabled,
  setValveActionAudioEnabled,
  speak,
} from "@/lib/audioSettings";

export default function SettingsPage() {
  const [valveAudio, setValveAudio] = useState(true);
  const [stepAudio, setStepAudio] = useState(true);

  useEffect(() => {
    setValveAudio(isValveActionAudioEnabled());
    setStepAudio(isStepCompleteAudioEnabled());
  }, []);

  function toggleValveAudio() {
    const next = !valveAudio;
    setValveAudio(next);
    setValveActionAudioEnabled(next);
    if (next) speak("V-1001を開操作しました");
  }

  function toggleStepAudio() {
    const next = !stepAudio;
    setStepAudio(next);
    setStepCompleteAudioEnabled(next);
    if (next) speak("作業工程１ ラインナップ完了しました");
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-12 dark:bg-black">
      <div className="mx-auto max-w-md">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← ホームに戻る
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">設定</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          制御室ダッシュボードで再生する音声通知を、この端末ごとにオン/オフできます。
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div>
              <p className="font-medium text-zinc-900 dark:text-zinc-100">バルブ操作音声</p>
              <p className="text-sm text-zinc-500">
                例:「V-1001を開操作しました」「V-1002を閉確認しました」
              </p>
            </div>
            <button
              onClick={toggleValveAudio}
              className={`relative h-7 w-12 flex-none rounded-full transition-colors ${
                valveAudio ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"
              }`}
            >
              <span
                className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-transform ${
                  valveAudio ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div>
              <p className="font-medium text-zinc-900 dark:text-zinc-100">工程完了音声</p>
              <p className="text-sm text-zinc-500">
                例:「作業工程１ ラインナップ完了しました」
              </p>
            </div>
            <button
              onClick={toggleStepAudio}
              className={`relative h-7 w-12 flex-none rounded-full transition-colors ${
                stepAudio ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"
              }`}
            >
              <span
                className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-transform ${
                  stepAudio ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>

        <p className="mt-4 text-xs text-zinc-400">
          切り替えると確認用に音声が1回再生されます。設定はこの端末のブラウザに保存されます。
        </p>
      </div>
    </main>
  );
}
