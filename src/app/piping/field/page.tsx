"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import PipingDiagram, { DiagramLegend, type PipeLayer } from "@/components/piping/PipingDiagram";
import { currentValveState } from "@/lib/piping/operations";
import { importPlanFromExcel, isOperateCell, newId, stateGlyph, type PlanRow, type SavedPlan } from "@/lib/piping/checklist";
import { actionText, execView } from "@/lib/piping/execution";
import { formatLiters, formatMinutes } from "@/lib/piping/isolation";
import { playBeep } from "@/lib/piping/sound";
import { recordKey, type Execution } from "@/lib/piping/store";
import { useGraph, useLocalValue, usePipingStore } from "@/lib/piping/usePiping";
import { isValveActionAudioEnabled, speak } from "@/lib/audioSettings";

const EXEC_KEY = "piping.field.execId";

type Flash = { type: "ok" | "err" | "info"; text: string };

export default function FieldPage() {
  const g = useGraph();
  const { store, act, error } = usePipingStore(1500);
  const [execId, selectExec] = useLocalValue(EXEC_KEY);
  const [view, setView] = useState<"diagram" | "table">("diagram");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [pending, setPending] = useState<PlanRow | null>(null);
  const [importInfo, setImportInfo] = useState<string[] | null>(null);


  const exec = store?.executions.find((e) => e.id === execId) ?? null;
  const plan = exec ? store?.plans.find((p) => p.id === exec.planId) ?? null : null;
  // 実際の弁状態の基準＝制御室で入力された運用状態（未入力なら待機状態）
  const operations = store?.operations;
  const overrides = store?.valveOverrides;
  const base = useMemo(
    () => currentValveState(g, operations ?? [], overrides ?? {}).valveState,
    [g, operations, overrides]
  );
  const v = useMemo(() => (plan && exec ? execView(plan, exec, base) : null), [plan, exec, base]);

  function showFlash(f: Flash) {
    setFlash(f);
    setTimeout(() => setFlash((cur) => (cur === f ? null : cur)), 3500);
  }

  async function record(row: PlanRow, result: "OK" | "NG") {
    if (!exec) return;
    await act({ action: "record", execId: exec.id, step: exec.currentStep, code: row.code, result });
    playBeep(result);
    if (result === "OK") {
      const msg = `${row.code}を${actionText(row, exec.currentStep)}しました`;
      showFlash({ type: "ok", text: msg });
      if (isValveActionAudioEnabled()) speak(msg);
    } else {
      showFlash({ type: "err", text: `${row.code} を異常（NG）として記録しました` });
    }
  }

  // QR読取・図面タップ共通：現在工程の対象かを判定する
  function handleCode(code: string, fromScan: boolean) {
    if (!exec || !plan || !v) return;
    const row = plan.rows.find((r) => r.code === code || r.nodeId === code);
    if (!row || !row.states[exec.currentStep]) {
      playBeep("NG");
      showFlash({ type: "err", text: `${code} は現在の工程「${plan.steps[exec.currentStep]}」の対象ではありません` });
      return;
    }
    const rec = exec.records[recordKey(exec.currentStep, row.code)];
    if (rec?.result === "OK") {
      showFlash({ type: "info", text: `${row.code} は記録済みです` });
      if (!fromScan) setPending(row);
      return;
    }
    if (fromScan) record(row, "OK");
    else setPending(row);
  }
  // QRコールバックから常に最新の handleCode を呼ぶ（stale closure 対策）
  const handleCodeRef = useRef(handleCode);
  useEffect(() => {
    handleCodeRef.current = handleCode;
  });

  // ───── QRスキャナー ─────
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const lastScanRef = useRef<{ code: string; at: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  async function startScanner() {
    setCameraError(null);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("piping-qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (text) => {
          const code = text.trim();
          const last = lastScanRef.current;
          if (last && last.code === code && Date.now() - last.at < 2500) return;
          lastScanRef.current = { code, at: Date.now() };
          handleCodeRef.current(code, true);
        },
        undefined
      );
      setScanning(true);
    } catch {
      setCameraError("カメラを起動できませんでした。図面またはチェックリストのバルブをタップして記録してください。");
    }
  }
  function stopScanner() {
    const s = scannerRef.current;
    if (s) {
      s.stop()
        .then(() => s.clear())
        .catch(() => {});
      scannerRef.current = null;
    }
    setScanning(false);
  }
  useEffect(() => () => stopScanner(), []);

  async function startPlan(planId: string) {
    const id = newId();
    await act({ action: "startExecution", planId, id });
    selectExec(id);
  }

  async function importExcel(file: File) {
    try {
      const { plan: p, unmatched, errors } = await importPlanFromExcel(g, file);
      if (!p.rows.length) {
        showFlash({ type: "err", text: "チェックリストに有効な行がありません" });
        return;
      }
      await act({ action: "savePlan", plan: p });
      setImportInfo([
        `「${p.name}」を取り込みました（${p.steps.length}工程・${p.rows.length}弁）`,
        ...(unmatched.length ? [`図面に無いバルブ：${unmatched.join("、")}（チェックリスト表でのみ記録できます）`] : []),
        ...errors,
      ]);
    } catch (e) {
      showFlash({ type: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }

  // ───────────── 点検未選択：一覧 ─────────────
  if (!exec || !plan || !v) {
    const running = (store?.executions ?? []).filter((e) => e.status === "in_progress");
    return (
      <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
        <div className="mx-auto max-w-3xl">
          <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← 配管系統図メニュー
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">② 現場点検（図面ビュー）</h1>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          {flash && <FlashBar flash={flash} />}

          <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">【点検中の作業】</p>
            {running.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">点検中の作業はありません。</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {running.map((e) => {
                  const p = store!.plans.find((x) => x.id === e.planId);
                  return (
                    <li key={e.id} className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-700 dark:bg-emerald-950">
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">{e.planName}</p>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">
                        現在工程：{p?.steps[e.currentStep] ?? "—"} ／ 開始：{new Date(e.startedAt).toLocaleString("ja-JP")}
                      </p>
                      <button
                        onClick={() => selectExec(e.id)}
                        className="mt-2 w-full rounded-lg bg-emerald-700 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
                      >
                        この点検を再開
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">新しい点検を開始</p>
            {(store?.plans ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                チェックリストがありません。<Link href="/piping/planner" className="text-emerald-700 underline">①で作成</Link>
                するか、既存形式のExcelを取り込んでください。
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
                {store!.plans.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name}</p>
                      <p className="text-xs text-zinc-500">
                        {p.source === "excel" ? "Excel取込" : p.purpose} ・ {p.steps.length}工程 ・ {p.rows.length}弁
                        {p.summary.volumeL ? ` ・ 抜取量 ${formatLiters(p.summary.volumeL)}` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => startPlan(p.id)}
                      className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600"
                    >
                      開始
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="mt-4 block rounded-lg border border-dashed border-zinc-300 p-3 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
              既存形式（バルブ×工程表）のExcelチェックリストを取り込む
              <input
                type="file"
                accept=".xlsx,.xls"
                className="mt-2 block w-full text-xs"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importExcel(f);
                  e.target.value = "";
                }}
              />
            </label>
            {importInfo && (
              <ul className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                {importInfo.map((t) => (
                  <li key={t}>・{t}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    );
  }

  // ───────────── 点検実施中 ─────────────
  const step = exec.currentStep;
  const layers: PipeLayer[] = [
    { key: "region", pipeIds: plan.regionPipeIds, color: "#ef4444", opacity: 0.45, blink: true },
    { key: "seal", pipeIds: plan.sealPipeIds, color: "#f59e0b", opacity: 0.35 },
  ];
  if (plan.steps[step] === "充填" && plan.fillPipeIds?.length) {
    layers.push({ key: "fill", pipeIds: plan.fillPipeIds, color: "#0d9488", width: 6, flow: true });
  }
  const completed = exec.status === "completed";

  return (
    <main className="min-h-screen bg-zinc-50 px-3 py-4 dark:bg-black">
      <div className="mx-auto max-w-[1600px]">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => { stopScanner(); selectExec(null); }} className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← 点検一覧
          </button>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{plan.name}</h1>
          {plan.summary.volumeL ? (
            <span className="text-xs text-zinc-500">
              抜取量 {formatLiters(plan.summary.volumeL)} ／ 抜取時間 {formatMinutes(plan.summary.drainMinutes)}
            </span>
          ) : null}
        </div>

        {/* 工程の進み具合 */}
        <ol className="mt-3 flex gap-1 overflow-x-auto">
          {plan.steps.map((s, i) => (
            <li
              key={s}
              className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-center text-sm ${
                i < step || completed
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : i === step
                    ? "bg-amber-400 font-semibold text-zinc-900"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900"
              }`}
            >
              {i === 0 ? s : `${i}. ${s}`}
            </li>
          ))}
        </ol>

        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div>
            <p className="text-xs text-zinc-500">現在の工程</p>
            <p className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              {completed ? "全工程完了" : plan.steps[step]}
              {!completed && (
                <span className="ml-2 text-base font-normal text-zinc-600">
                  {v.done} / {v.total}
                </span>
              )}
            </p>
          </div>
          <div className="h-2 min-w-32 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${v.total ? (v.done / v.total) * 100 : 0}%` }} />
          </div>
          {!completed && v.stepComplete && !v.isLastStep && (
            <button
              onClick={() => act({ action: "advanceStep", execId: exec.id })}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
            >
              次の工程「{plan.steps[step + 1]}」を開始
            </button>
          )}
          {!completed && v.stepComplete && v.isLastStep && (
            <button
              onClick={() => act({ action: "completeExecution", execId: exec.id })}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
            >
              点検を完了する
            </button>
          )}
          <div className="flex overflow-hidden rounded-lg border border-zinc-300 text-sm dark:border-zinc-700">
            <button onClick={() => setView("diagram")} className={`px-3 py-1.5 ${view === "diagram" ? "bg-zinc-800 text-white" : ""}`}>
              図面
            </button>
            <button onClick={() => setView("table")} className={`px-3 py-1.5 ${view === "table" ? "bg-zinc-800 text-white" : ""}`}>
              チェックリスト
            </button>
          </div>
          <button
            onClick={scanning ? stopScanner : startScanner}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${scanning ? "bg-zinc-700 text-white" : "bg-sky-600 text-white"}`}
          >
            {scanning ? "QR読取を停止" : "QRで読み取る"}
          </button>
        </div>

        {flash && <FlashBar flash={flash} />}
        {cameraError && <p className="mt-2 text-sm text-red-600">{cameraError}</p>}
        <div id="piping-qr-reader" className={`mx-auto mt-2 max-w-sm overflow-hidden rounded-xl ${scanning ? "" : "hidden"}`} />

        {plan.summary.warnings.length > 0 && (
          <details className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <summary className="cursor-pointer font-medium">注意事項（{plan.summary.warnings.length}件）</summary>
            <ul className="mt-1 list-disc pl-5">
              {plan.summary.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}

        <div className="mt-3">
          {view === "diagram" ? (
            <>
              <PipingDiagram
                graph={g}
                valveState={v.valveState}
                layers={layers}
                marks={v.marks}
                clickableKinds={["valve", "drain", "gauge"]}
                onNodeClick={(id) => handleCode(g.nodeById.get(id)!.label, false)}
                height="62vh"
              />
              <div className="mt-2">
                <DiagramLegend
                  items={[
                    { color: "#ef4444", label: "点検範囲（点滅）" },
                    { color: "#f59e0b", label: "この工程で操作（点滅）", kind: "blink" },
                    { color: "#22c55e", label: "操作済み（点灯）", kind: "ring" },
                    { color: "#2563eb", label: "制御室確認済み", kind: "ring" },
                  ]}
                />
              </div>
            </>
          ) : (
            <StepTable plan={plan} exec={exec} onTap={(r) => handleCode(r.code, false)} />
          )}
        </div>

        {/* 現在工程の対象一覧（図面表示時の補助） */}
        {view === "diagram" && !completed && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {v.targets.map((r) => {
              const rec = exec.records[recordKey(step, r.code)];
              return (
                <button
                  key={r.code}
                  onClick={() => handleCode(r.code, false)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm ${
                    rec?.result === "OK"
                      ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
                      : rec?.result === "NG"
                        ? "border-red-400 bg-red-50 dark:bg-red-950"
                        : "border-amber-300 bg-white dark:border-amber-800 dark:bg-zinc-950"
                  }`}
                >
                  <span className="font-semibold">{rec?.result === "OK" ? "☑" : "☐"} {r.code}</span>
                  <span className={`ml-2 rounded px-1.5 text-xs text-white ${r.states[step] === "close" ? "bg-red-500" : "bg-emerald-500"}`}>
                    {actionText(r, step)}
                  </span>
                  <span className="block truncate text-xs text-zinc-500">{r.name}</span>
                  {r.note && <span className="block text-xs font-medium text-amber-700">※{r.note}</span>}
                  {rec?.confirmedAt && <span className="text-[11px] text-blue-600">制御室確認済み</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* タップ時の確認ダイアログ */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setPending(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs text-zinc-500">{pending.name}</p>
            <p className="mt-1 text-2xl font-semibold">{pending.code}</p>
            {pending.note && <p className="mt-1 text-sm font-medium text-amber-700">※{pending.note}</p>}
            {exec.records[recordKey(step, pending.code)]?.result === "OK" ? (
              <>
                <p className="mt-2 text-sm text-zinc-600">記録済みです。取り消しますか？</p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button onClick={() => setPending(null)} className="rounded-lg border border-zinc-300 py-2.5 text-sm">
                    閉じる
                  </button>
                  <button
                    onClick={async () => {
                      await act({ action: "undoRecord", execId: exec.id, step, code: pending.code });
                      setPending(null);
                    }}
                    className="rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white"
                  >
                    記録を取り消す
                  </button>
                </div>
              </>
            ) : (
              <>
                <p
                  className={`mt-3 rounded-lg py-3 text-center text-xl font-bold text-white ${
                    pending.states[step] === "close" ? "bg-red-500" : "bg-emerald-500"
                  }`}
                >
                  {actionText(pending, step)}
                </p>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <button onClick={() => setPending(null)} className="rounded-lg border border-zinc-300 py-2.5 text-sm">
                    キャンセル
                  </button>
                  <button
                    onClick={() => {
                      record(pending, "NG");
                      setPending(null);
                    }}
                    className="rounded-lg bg-red-700 py-2.5 text-sm font-semibold text-white"
                  >
                    NG
                  </button>
                  <button
                    onClick={() => {
                      record(pending, "OK");
                      setPending(null);
                    }}
                    className={`rounded-lg py-2.5 text-sm font-semibold text-white ${
                      pending.states[step] === "close" ? "bg-red-500" : "bg-emerald-600"
                    }`}
                  >
                    記録する
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function FlashBar({ flash }: { flash: Flash }) {
  const cls =
    flash.type === "ok"
      ? "bg-emerald-600 text-white"
      : flash.type === "err"
        ? "bg-red-600 text-white"
        : "bg-zinc-700 text-white";
  return <div className={`mt-2 rounded-lg px-4 py-2 text-sm font-medium ${cls}`}>{flash.text}</div>;
}

// 既存の現場チェック画面と同じ「バルブ×工程」表示
function StepTable({
  plan,
  exec,
  onTap,
}: {
  plan: SavedPlan;
  exec: Execution;
  onTap: (r: PlanRow) => void;
}) {
  return (
    <div className="overflow-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
          <tr>
            <th className="px-3 py-2 text-left font-medium">バルブ</th>
            {plan.steps.map((s, i) => (
              <th key={s} className={`px-2 py-2 text-center font-medium ${i === exec.currentStep ? "bg-amber-100 text-zinc-900 dark:bg-amber-900 dark:text-white" : ""}`}>
                {s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plan.rows.map((r) => (
            <tr key={r.code} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="px-3 py-2">
                <p className="font-medium">{r.code}</p>
                <p className="text-xs text-zinc-500">{r.name}</p>
                {r.note && <p className="text-xs text-amber-700">※{r.note}</p>}
              </td>
              {r.states.map((s, i) => {
                const rec = exec.records[recordKey(i, r.code)];
                const current = i === exec.currentStep && exec.status === "in_progress";
                const operate = isOperateCell(r, i);
                return (
                  <td key={i} className="px-2 py-2 text-center">
                    <button
                      disabled={!current || !s}
                      onClick={() => onTap(r)}
                      className={`inline-flex min-w-14 items-center justify-center gap-1 rounded-lg px-2 py-1.5 ${
                        !s
                          ? "text-zinc-300 dark:text-zinc-700"
                          : rec?.result === "NG"
                            ? "bg-red-600 text-white"
                            : i === 0 || !operate
                              ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                              : s === "close"
                                ? "bg-red-500 text-white"
                                : "bg-emerald-500 text-white"
                      } ${current && s && !rec ? "ring-2 ring-amber-400" : ""}`}
                    >
                      {stateGlyph(s)}
                      {s && i > 0 && <span>{rec?.result === "OK" ? "☑" : "☐"}</span>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
