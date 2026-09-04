"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  clearActiveSession,
  ensureActiveSession,
  type InspectionSession,
} from "@/lib/inspectionSession";
import {
  clearActiveChecklist,
  getActiveChecklist,
  setActiveChecklist,
  type ActiveChecklist,
} from "@/lib/activeChecklist";

type TemplateOption = {
  id: string;
  name: string;
  itemCount: number;
};

type ValveProgress = {
  equipmentId: string;
  code: string;
  name: string;
  required: number;
  done: number;
};

export default function InspectScannerPage() {
  const router = useRouter();
  const [session, setSession] = useState<InspectionSession | null>(null);
  const [checklist, setChecklist] = useState<ActiveChecklist | null>(null);

  // 作業選択
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [searchText, setSearchText] = useState("");

  // 選択中の作業の概要
  const [steps, setSteps] = useState<string[]>([]);
  const [valves, setValves] = useState<ValveProgress[]>([]);
  const [loadingOverview, setLoadingOverview] = useState(false);

  // スキャナー
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    ensureActiveSession().then(setSession);
    setChecklist(getActiveChecklist());
    return () => {
      stopScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    const { data } = await supabase
      .from("checklist_templates")
      .select("id, name, checklist_items(count)")
      .order("created_at", { ascending: false });
    if (data) {
      setTemplates(
        data.map((t) => ({
          id: t.id,
          name: t.name,
          itemCount: (t.checklist_items as { count: number }[])[0]?.count ?? 0,
        }))
      );
    }
    setLoadingTemplates(false);
  }, []);

  useEffect(() => {
    if (!checklist) loadTemplates();
  }, [checklist, loadTemplates]);

  const loadOverview = useCallback(async () => {
    if (!checklist || !session) return;
    setLoadingOverview(true);

    const { data: items } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name")
      .eq("template_id", checklist.id)
      .order("item_no", { ascending: true });

    const itemList = items ?? [];
    setSteps(itemList.map((i) => i.item_name));
    const itemIds = itemList.map((i) => i.id);

    if (itemIds.length === 0) {
      setValves([]);
      setLoadingOverview(false);
      return;
    }

    const { data: mappings } = await supabase
      .from("checklist_item_equipment")
      .select("item_id, equipment_id, equipment(code, name)")
      .in("item_id", itemIds);

    const { data: results } = await supabase
      .from("inspection_results")
      .select("equipment_id, item_id")
      .eq("session_id", session.id)
      .in("item_id", itemIds);

    const doneSet = new Set((results ?? []).map((r) => `${r.equipment_id}:${r.item_id}`));

    const valveMap = new Map<string, ValveProgress>();
    (mappings ?? []).forEach((m) => {
      const eq = m.equipment as unknown as { code: string; name: string } | null;
      if (!eq) return;
      const existing = valveMap.get(m.equipment_id) ?? {
        equipmentId: m.equipment_id,
        code: eq.code,
        name: eq.name,
        required: 0,
        done: 0,
      };
      existing.required += 1;
      if (doneSet.has(`${m.equipment_id}:${m.item_id}`)) existing.done += 1;
      valveMap.set(m.equipment_id, existing);
    });

    setValves(Array.from(valveMap.values()).sort((a, b) => a.code.localeCompare(b.code)));
    setLoadingOverview(false);
  }, [checklist, session]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  function selectChecklist(t: TemplateOption) {
    setActiveChecklist({ id: t.id, name: t.name });
    setChecklist({ id: t.id, name: t.name });
  }

  function changeChecklist() {
    stopScanner();
    clearActiveChecklist();
    setChecklist(null);
    setSteps([]);
    setValves([]);
  }

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

  const filteredTemplates = templates.filter((t) =>
    t.name.toLowerCase().includes(searchText.trim().toLowerCase())
  );

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

        {!checklist ? (
          <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              作業（チェックリスト）を選択してください
            </p>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="作業名で検索（例: 第1系統）"
              className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />

            <div className="mt-3 flex flex-col gap-2">
              {loadingTemplates ? (
                <p className="text-sm text-zinc-500">読み込み中...</p>
              ) : filteredTemplates.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  該当する作業が見つかりません。
                  <Link href="/checklists" className="ml-1 text-emerald-700 hover:underline dark:text-emerald-400">
                    チェックリストを取り込む
                  </Link>
                </p>
              ) : (
                filteredTemplates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => selectChecklist(t)}
                    className="rounded-lg border border-zinc-200 p-3 text-left hover:border-emerald-400 hover:bg-emerald-50 dark:border-zinc-800 dark:hover:bg-emerald-950"
                  >
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{t.name}</p>
                    <p className="text-xs text-zinc-500">{t.itemCount}工程</p>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-zinc-500">選択中の作業</p>
                  <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                    {checklist.name}
                  </p>
                </div>
                <button
                  onClick={changeChecklist}
                  className="whitespace-nowrap text-sm text-zinc-500 hover:underline"
                >
                  作業を変更
                </button>
              </div>
              {steps.length > 0 && (
                <p className="mt-2 text-xs text-zinc-500">工程: {steps.join(" → ")}</p>
              )}
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

              <div className="mt-4 flex gap-2">
                <input
                  type="text"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && manualCode.trim()) goToCode(manualCode);
                  }}
                  placeholder="読み取れない場合はバルブ名を直接入力（例: V-1001）"
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

            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                対象バルブ（{valves.length}台）
              </p>
              {loadingOverview ? (
                <p className="mt-2 text-sm text-zinc-500">読み込み中...</p>
              ) : valves.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">
                  このチェックリストに紐づくバルブがありません。
                </p>
              ) : (
                <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
                  {valves.map((v) => {
                    const complete = v.done >= v.required;
                    return (
                      <li key={v.equipmentId} className="flex items-center justify-between py-2">
                        <Link
                          href={`/inspect/${encodeURIComponent(v.code)}`}
                          className="flex-1 hover:underline"
                        >
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">
                            {v.code}
                          </span>
                          <span className="ml-2 text-xs text-zinc-500">{v.name}</span>
                        </Link>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            complete
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
                              : v.done > 0
                              ? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
                              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                          }`}
                        >
                          {v.done}/{v.required}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
