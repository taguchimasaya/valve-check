"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { ensureActiveSession, type InspectionSession } from "@/lib/inspectionSession";

type EquipmentInfo = {
  id: string;
  code: string;
  name: string;
  hierarchy1: string | null;
  hierarchy2: string | null;
  hierarchy3: string | null;
  hierarchy4: string | null;
  valve_type: string | null;
  checklist_template_id: string | null;
};

type ChecklistItem = {
  id: string;
  item_no: number;
  item_name: string;
  criteria: string | null;
};

type ResultValue = "OK" | "NG" | "NA";

type ItemState = {
  result: ResultValue | null;
  comment: string;
  saving: boolean;
};

function hierarchyPath(eq: EquipmentInfo) {
  return [eq.hierarchy1, eq.hierarchy2, eq.hierarchy3, eq.hierarchy4]
    .filter(Boolean)
    .join(" > ");
}

export default function InspectEquipmentPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [session, setSession] = useState<InspectionSession | null>(null);
  const [equipment, setEquipment] = useState<EquipmentInfo | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [bulkSaving, setBulkSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    const activeSession = await ensureActiveSession();
    if (!activeSession) {
      setLoadError("点検セッションを開始できませんでした。通信環境を確認してください。");
      setLoading(false);
      return;
    }
    setSession(activeSession);

    const { data: eq, error: eqError } = await supabase
      .from("equipment")
      .select(
        "id, code, name, hierarchy1, hierarchy2, hierarchy3, hierarchy4, valve_type, checklist_template_id"
      )
      .eq("code", code)
      .maybeSingle();

    if (eqError || !eq) {
      setLoadError(`機器番号「${code}」は登録されていません。QRコードを確認してください。`);
      setLoading(false);
      return;
    }
    setEquipment(eq);

    if (!eq.checklist_template_id) {
      setLoading(false);
      return;
    }

    const { data: checklistItems } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name, criteria")
      .eq("template_id", eq.checklist_template_id)
      .order("item_no", { ascending: true });

    const allItems = checklistItems ?? [];
    const itemIds = allItems.map((i) => i.id);

    // 「バルブ×工程」形式のチェックリストは、このバルブが操作対象の工程だけを表示する。
    // 紐付け（checklist_item_equipment）が1件も無いテンプレートは、
    // 全バルブ共通の点検項目リスト形式とみなし、全項目を表示する。
    let visibleItems = allItems;
    if (itemIds.length > 0) {
      const [{ data: mappedForThis }, { count: totalMappings }] = await Promise.all([
        supabase
          .from("checklist_item_equipment")
          .select("item_id")
          .eq("equipment_id", eq.id)
          .in("item_id", itemIds),
        supabase
          .from("checklist_item_equipment")
          .select("item_id", { count: "exact", head: true })
          .in("item_id", itemIds),
      ]);
      if ((totalMappings ?? 0) > 0) {
        const mappedSet = new Set((mappedForThis ?? []).map((m) => m.item_id));
        visibleItems = allItems.filter((i) => mappedSet.has(i.id));
      }
    }

    setItems(visibleItems);

    const { data: existingResults } = await supabase
      .from("inspection_results")
      .select("item_id, result, comment")
      .eq("session_id", activeSession.id)
      .eq("equipment_id", eq.id);

    const initialStates: Record<string, ItemState> = {};
    visibleItems.forEach((item) => {
      const existing = existingResults?.find((r) => r.item_id === item.id);
      initialStates[item.id] = {
        result: (existing?.result as ResultValue | undefined) ?? null,
        comment: existing?.comment ?? "",
        saving: false,
      };
    });
    setStates(initialStates);
    setLoading(false);
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveResult(itemId: string, result: ResultValue, comment: string) {
    if (!session || !equipment) return;
    setStates((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], result, comment, saving: true },
    }));
    const { error } = await supabase.from("inspection_results").upsert(
      {
        session_id: session.id,
        equipment_id: equipment.id,
        item_id: itemId,
        result,
        comment: comment || null,
        checked_at: new Date().toISOString(),
      },
      { onConflict: "session_id,equipment_id,item_id" }
    );
    setStates((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], saving: false },
    }));
    if (error) {
      window.alert(`保存に失敗しました: ${error.message}`);
    }
  }

  function handleCommentChange(itemId: string, comment: string) {
    setStates((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], comment },
    }));
  }

  function handleCommentBlur(itemId: string) {
    const s = states[itemId];
    if (s?.result) saveResult(itemId, s.result, s.comment);
  }

  async function markRemainingOk() {
    if (!session || !equipment) return;
    const remaining = items.filter((item) => !states[item.id]?.result);
    if (remaining.length === 0) return;
    setBulkSaving(true);
    const { error } = await supabase.from("inspection_results").upsert(
      remaining.map((item) => ({
        session_id: session.id,
        equipment_id: equipment.id,
        item_id: item.id,
        result: "OK" as const,
        comment: null,
        checked_at: new Date().toISOString(),
      })),
      { onConflict: "session_id,equipment_id,item_id" }
    );
    setBulkSaving(false);
    if (error) {
      window.alert(`保存に失敗しました: ${error.message}`);
      return;
    }
    setStates((prev) => {
      const next = { ...prev };
      remaining.forEach((item) => {
        next[item.id] = { result: "OK", comment: "", saving: false };
      });
      return next;
    });
  }

  const checkedCount = items.filter((item) => states[item.id]?.result).length;
  const ngCount = items.filter((item) => states[item.id]?.result === "NG").length;

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 dark:bg-black">
        <p className="text-zinc-500">読み込み中...</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center dark:bg-black">
        <p className="text-red-600 dark:text-red-400">{loadError}</p>
        <Link href="/inspect" className="text-emerald-700 underline dark:text-emerald-400">
          スキャナーに戻る
        </Link>
      </main>
    );
  }

  if (!equipment) return null;

  return (
    <main className="min-h-screen bg-zinc-50 pb-28 dark:bg-black">
      <div className="mx-auto max-w-2xl px-4 py-6">
        <Link
          href="/inspect"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400"
        >
          ← スキャナーに戻る
        </Link>

        <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs text-zinc-500">{session?.title}</p>
          <h1 className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-50">
            {equipment.code}
          </h1>
          <p className="text-zinc-700 dark:text-zinc-300">{equipment.name}</p>
          <p className="mt-1 text-sm text-zinc-500">
            {hierarchyPath(equipment) || "—"}
            {equipment.valve_type && ` ・ ${equipment.valve_type}`}
          </p>
        </div>

        {!equipment.checklist_template_id ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            この機器にはチェックリストが割り当てられていません。機器マスター管理画面から割り当ててください。
          </div>
        ) : items.length === 0 ? (
          <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
            このバルブが対象となる工程がありません（この手順ではこのバルブは操作対象外です）。
          </div>
        ) : (
          <>
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {checkedCount}/{items.length}項目チェック済み
                {ngCount > 0 && (
                  <span className="ml-2 font-medium text-red-600 dark:text-red-400">
                    NG {ngCount}件
                  </span>
                )}
              </p>
              {checkedCount < items.length && (
                <button
                  onClick={markRemainingOk}
                  disabled={bulkSaving}
                  className="rounded-lg border border-emerald-600 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
                >
                  残りをすべてOKにする
                </button>
              )}
            </div>

            <ul className="mt-3 flex flex-col gap-3">
              {items.map((item) => {
                const s = states[item.id] ?? { result: null, comment: "", saving: false };
                return (
                  <li
                    key={item.id}
                    className={`rounded-xl border p-4 dark:bg-zinc-950 ${
                      s.result === "NG"
                        ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
                        : s.result === "OK"
                        ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
                        : s.result === "NA"
                        ? "border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900"
                        : "border-zinc-200 bg-white dark:border-zinc-800"
                    }`}
                  >
                    <p className="text-xs text-zinc-400">項目 {item.item_no}</p>
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">
                      {item.item_name}
                    </p>
                    {item.criteria && (
                      <p className="mt-0.5 text-sm text-zinc-500">{item.criteria}</p>
                    )}

                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <button
                        onClick={() => saveResult(item.id, "OK", s.comment)}
                        className={`rounded-lg py-3 text-base font-semibold ${
                          s.result === "OK"
                            ? "bg-emerald-600 text-white"
                            : "bg-zinc-100 text-zinc-700 hover:bg-emerald-100 dark:bg-zinc-800 dark:text-zinc-200"
                        }`}
                      >
                        OK
                      </button>
                      <button
                        onClick={() => saveResult(item.id, "NG", s.comment)}
                        className={`rounded-lg py-3 text-base font-semibold ${
                          s.result === "NG"
                            ? "bg-red-600 text-white"
                            : "bg-zinc-100 text-zinc-700 hover:bg-red-100 dark:bg-zinc-800 dark:text-zinc-200"
                        }`}
                      >
                        NG
                      </button>
                      <button
                        onClick={() => saveResult(item.id, "NA", s.comment)}
                        className={`rounded-lg py-3 text-base font-semibold ${
                          s.result === "NA"
                            ? "bg-zinc-500 text-white"
                            : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200"
                        }`}
                      >
                        対象外
                      </button>
                    </div>

                    <input
                      type="text"
                      value={s.comment}
                      onChange={(e) => handleCommentChange(item.id, e.target.value)}
                      onBlur={() => handleCommentBlur(item.id)}
                      placeholder="備考（任意）"
                      className="mt-2 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                  </li>
                );
              })}
            </ul>

            {checkedCount === items.length && (
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
                この機器の点検は完了しました。
                <Link href="/inspect" className="ml-2 underline">
                  次の機器をスキャン
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
