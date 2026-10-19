"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import PipingDiagram, {
  DiagramLegend,
  type DiagramHandle,
  type NodeMark,
  type PipeLayer,
} from "@/components/piping/PipingDiagram";
import { currentValveState } from "@/lib/piping/operations";
import {
  importPlanFromExcel,
  isOperateCell,
  newId,
  ROLE_LABEL,
  stateAtStep,
  stateGlyph,
  type PlanRow,
  type RowRole,
  type SavedPlan,
} from "@/lib/piping/checklist";
import type { Graph } from "@/lib/piping/graph";
import { stepFlow } from "@/lib/piping/flow";
import type { ValveState } from "@/lib/piping/types";
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
  const diagramRef = useRef<DiagramHandle>(null);
  // チェックリストのタグ・表から、図面上の位置を表示する（表表示中なら図面に切り替える）
  function locateOnDiagram(nodeId: string) {
    if (view !== "diagram") {
      setView("diagram");
      setTimeout(() => diagramRef.current?.focusNode(nodeId), 50);
    } else diagramRef.current?.focusNode(nodeId);
  }
  const pendingRef = useRef<PlanRow | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  // 開閉の選び間違い（開操作対象で閉操作を選んだ等）の表示
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const [importInfo, setImportInfo] = useState<string[] | null>(null);
  // 一覧画面：検索語、プレビュー表示中のチェックリスト（点検記録つきの場合は execId も）
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<{ planId: string; execId?: string } | null>(null);


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

  // 工程が変わったとき（点検を開いたときを含む）は、その工程の対象バルブ付近を表示する
  const fitIdsRef = useRef<string[]>([]);
  useEffect(() => {
    fitIdsRef.current = (v?.targets ?? []).map((r) => r.nodeId).filter((id): id is string => !!id);
  });
  const fitKey = exec && view === "diagram" ? `${exec.id}:${exec.currentStep}` : null;
  useEffect(() => {
    if (!fitKey) return;
    const t = setTimeout(() => diagramRef.current?.fitNodes(fitIdsRef.current), 80);
    return () => clearTimeout(t);
  }, [fitKey]);

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

  function openDialog(row: PlanRow) {
    setChoiceError(null);
    setPending(row);
  }

  // ダイアログで選んだ開閉が、この工程の目標状態と一致するときだけ記録する
  function choose(row: PlanRow, state: "open" | "close") {
    if (!exec) return;
    const target = row.states[exec.currentStep];
    if (state !== target) {
      playBeep("NG");
      setChoiceError(
        `${row.code} は${target === "close" ? "閉" : "開"}操作の対象です。${state === "close" ? "閉" : "開"}操作は選択できません。`
      );
      return;
    }
    record(row, "OK");
    setPending(null);
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
      if (!fromScan) openDialog(row);
      return;
    }
    // QR読取でもタップでも、開閉を選ぶダイアログで確認してから記録する（結果音は選択後）
    openDialog(row);
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
  // 読取枠を表示しているか（カメラ起動中も含む）。枠が非表示（幅0）のままだと
  // html5-qrcode が読取範囲を計算できず起動に失敗するため、先に枠を表示してから起動する。
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const readerBoxRef = useRef<HTMLDivElement>(null);

  async function startScanner() {
    setCameraError(null);
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setCameraError(
        "カメラは HTTPS で開いたときだけ使えます。https://（PCのIPアドレス）:3000/piping/field で開き直してください。"
      );
      return;
    }
    setScannerOpen(true);
    // 枠が描画されてから起動する
    await new Promise((r) => setTimeout(r, 50));
    readerBoxRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("piping-qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          // 読取範囲は映像の大きさに合わせる（固定サイズだと小さい画面で起動に失敗することがある）
          qrbox: (w: number, h: number) => {
            const size = Math.max(120, Math.floor(Math.min(w, h) * 0.7));
            return { width: size, height: size };
          },
        },
        (text) => {
          // 既存の機器QRと同じ「…/inspect/{機器番号}」形式でも、番号だけのQRでも読めるようにする
          const raw = text.trim();
          const marker = raw.indexOf("/inspect/");
          const code = safeDecode(marker >= 0 ? raw.slice(marker + "/inspect/".length) : raw).trim();
          // 開閉の確認ダイアログを表示している間は、次のQRを読まない
          if (pendingRef.current) return;
          const last = lastScanRef.current;
          if (last && last.code === code && Date.now() - last.at < 2500) return;
          lastScanRef.current = { code, at: Date.now() };
          handleCodeRef.current(code, true);
        },
        undefined
      );
      setScanning(true);
    } catch (e) {
      scannerRef.current = null;
      setScannerOpen(false);
      // html5-qrcode はエラーを文字列で返すことがあるため、名前・本文の両方から原因を判定する
      const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      const reason = /NotAllowedError|Permission/i.test(text)
        ? "カメラの使用が許可されていません。ブラウザのサイト設定でカメラを許可してください。"
        : /NotFoundError|OverconstrainedError/i.test(text)
          ? "カメラが見つかりません。"
          : /NotReadableError|TrackStartError/i.test(text)
            ? "カメラを他のアプリが使用中です。他のアプリやタブを閉じてから再度お試しください。"
            : `（${text}）`;
      setCameraError(`カメラを起動できませんでした：${reason} 図面またはチェックリストのバルブをタップしても記録できます。`);
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
    setScannerOpen(false);
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
    const plans = store?.plans ?? [];
    const executions = store?.executions ?? [];
    const planById = new Map(plans.map((p) => [p.id, p]));
    const q = normalize(search);
    const planHit = (p: SavedPlan | undefined) =>
      !!p &&
      [p.name, p.purpose, ...p.rows.flatMap((r) => [r.code, r.name])].some((t) => normalize(t).includes(q));
    const execHit = (e: Execution) => !q || normalize(e.planName).includes(q) || planHit(planById.get(e.planId));
    const running = executions.filter((e) => e.status === "in_progress" && execHit(e));
    const completed = executions.filter((e) => e.status === "completed" && execHit(e));
    const shownPlans = plans.filter((p) => !q || planHit(p));

    async function deletePlan(p: SavedPlan) {
      const n = executions.filter((e) => e.planId === p.id).length;
      const msg = `チェックリスト「${p.name}」を削除しますか？${n ? `\nこのチェックリストの点検記録（${n}件）も削除されます。` : ""}\n（ローカルデータのみ・元に戻せません）`;
      if (!confirm(msg)) return;
      await act({ action: "deletePlan", id: p.id });
      setPreview(null);
      showFlash({ type: "info", text: `「${p.name}」を削除しました` });
    }
    async function deleteExec(e: Execution) {
      if (!confirm(`点検「${e.planName}」（開始：${new Date(e.startedAt).toLocaleString("ja-JP")}）の記録を削除しますか？\n（元に戻せません）`)) return;
      await act({ action: "deleteExecution", execId: e.id });
      setPreview(null);
      showFlash({ type: "info", text: `点検「${e.planName}」の記録を削除しました` });
    }

    const previewPlan = preview ? planById.get(preview.planId) : undefined;
    const previewExec = preview?.execId ? executions.find((e) => e.id === preview.execId) : undefined;

    const execItem = (e: Execution, tone: "running" | "done") => {
      const p = planById.get(e.planId);
      return (
        <li
          key={e.id}
          className={`rounded-lg border p-3 ${
            tone === "running"
              ? "border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950"
              : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
          }`}
        >
          <p className="font-medium text-zinc-900 dark:text-zinc-100">{e.planName}</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {tone === "running" ? `現在工程：${p?.steps[e.currentStep] ?? "—"} ／ ` : "完了 ／ "}
            開始：{new Date(e.startedAt).toLocaleString("ja-JP")}
          </p>
          <div className="mt-2 flex gap-2">
            {tone === "running" && (
              <button
                onClick={() => selectExec(e.id)}
                className="flex-1 rounded-lg bg-emerald-700 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
              >
                この点検を再開
              </button>
            )}
            <button
              onClick={() => setPreview({ planId: e.planId, execId: e.id })}
              disabled={!p}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              プレビュー
            </button>
            <button
              onClick={() => deleteExec(e)}
              className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-zinc-900 dark:text-red-400"
            >
              削除
            </button>
          </div>
        </li>
      );
    };

    return (
      <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
        <div className="mx-auto max-w-3xl">
          <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← 配管系統図メニュー
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">② 現場点検（図面ビュー）</h1>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          {flash && <FlashBar flash={flash} />}

          <div className="mt-4 flex items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="作業名・目的・バルブ番号で検索（例：FLT-RA2、V-101R、フィルター）"
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            {search && (
              <span className="whitespace-nowrap text-xs text-zinc-500">
                {running.length + completed.length + shownPlans.length}件
              </span>
            )}
          </div>

          <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">【点検中の作業】</p>
            {running.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">{q ? "該当する点検中の作業はありません。" : "点検中の作業はありません。"}</p>
            ) : (
              <ul className="mt-2 space-y-2">{running.map((e) => execItem(e, "running"))}</ul>
            )}
          </section>

          <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">新しい点検を開始</p>
            {plans.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                チェックリストがありません。<Link href="/piping/planner" className="text-emerald-700 underline">①で作成</Link>
                するか、既存形式のExcelを取り込んでください。
              </p>
            ) : shownPlans.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">該当するチェックリストはありません。</p>
            ) : (
              <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
                {shownPlans.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name}</p>
                      <p className="text-xs text-zinc-500">
                        {p.source === "excel" ? "Excel取込" : p.purpose} ・ {p.steps.length}工程 ・ {p.rows.length}弁
                        {p.summary.volumeL ? ` ・ 抜取量 ${formatLiters(p.summary.volumeL)}` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => setPreview({ planId: p.id })}
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
                    >
                      プレビュー
                    </button>
                    <button
                      onClick={() => startPlan(p.id)}
                      className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600"
                    >
                      開始
                    </button>
                    <button
                      onClick={() => deletePlan(p)}
                      className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 dark:border-red-900 dark:text-red-400"
                    >
                      削除
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

          {completed.length > 0 && (
            <details className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950" open={!!q}>
              <summary className="cursor-pointer text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                完了した点検（{completed.length}）
              </summary>
              <ul className="mt-2 space-y-2">{completed.map((e) => execItem(e, "done"))}</ul>
            </details>
          )}
        </div>

        {previewPlan && (
          <PlanPreview
            graph={g}
            plan={previewPlan}
            exec={previewExec}
            base={base}
            onClose={() => setPreview(null)}
            onStart={
              previewExec
                ? previewExec.status === "in_progress"
                  ? () => {
                      setPreview(null);
                      selectExec(previewExec.id);
                    }
                  : undefined
                : () => {
                    setPreview(null);
                    startPlan(previewPlan.id);
                  }
            }
            startLabel={previewExec ? "この点検を再開" : "この内容で点検を開始"}
            onDelete={() => (previewExec ? deleteExec(previewExec) : deletePlan(previewPlan))}
            deleteLabel={previewExec ? "この点検記録を削除" : "チェックリストを削除"}
          />
        )}
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
            onClick={scannerOpen ? stopScanner : startScanner}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${scannerOpen ? "bg-zinc-700 text-white" : "bg-sky-600 text-white"}`}
          >
            {scannerOpen ? "QR読取を停止" : "QRで読み取る"}
          </button>
        </div>

        {flash && <FlashBar flash={flash} />}
        {cameraError && <p className="mt-2 text-sm text-red-600">{cameraError}</p>}
        {scannerOpen && (
          <div ref={readerBoxRef} className="mx-auto mt-2 w-full max-w-sm">
            {!scanning && <p className="py-2 text-center text-sm text-zinc-500">カメラを起動しています…</p>}
            <div id="piping-qr-reader" className="min-h-48 w-full overflow-hidden rounded-xl bg-black" />
            {scanning && (
              <button
                onClick={stopScanner}
                className="mt-2 w-full rounded-lg border border-zinc-300 py-2 text-sm dark:border-zinc-700"
              >
                QR読取を停止
              </button>
            )}
          </div>
        )}

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
                ref={diagramRef}
                graph={g}
                valveState={v.valveState}
                layers={layers}
                marks={v.marks}
                clickableKinds={["valve", "drain", "gauge"]}
                onNodeClick={(id) => handleCode(g.nodeById.get(id)!.label, false)}
                height="62vh"
                toolbar={
                  <button
                    onClick={() => diagramRef.current?.fitNodes(fitIdsRef.current)}
                    className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
                  >
                    対象付近を表示
                  </button>
                }
              />
              <div className="mt-2">
                <DiagramLegend
                  items={[
                    { color: "#ef4444", label: "点検範囲（点滅）" },
                    { color: "#dc2626", label: "閉操作待ち（点滅）", kind: "blink" },
                    { color: "#2563eb", label: "開操作待ち（点滅）", kind: "blink" },
                    { color: "#f59e0b", label: "確認待ち（点滅）", kind: "blink" },
                    { color: "#22c55e", label: "操作済み（点灯）", kind: "ring" },
                    { color: "#15803d", label: "制御室確認済み", kind: "ring" },
                  ]}
                />
              </div>
            </>
          ) : (
            <StepTable plan={plan} exec={exec} onTap={(r) => handleCode(r.code, false)} onLocate={locateOnDiagram} />
          )}
        </div>

        {/* 現在工程の対象一覧（図面表示時の補助） */}
        {view === "diagram" && !completed && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {v.targets.map((r) => {
              const rec = exec.records[recordKey(step, r.code)];
              return (
                <div
                  key={r.code}
                  role="button"
                  tabIndex={0}
                  title="クリックで図面上の位置を表示"
                  onClick={() => (r.nodeId ? locateOnDiagram(r.nodeId) : handleCode(r.code, false))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && r.nodeId) locateOnDiagram(r.nodeId);
                  }}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm ${
                    rec?.result === "OK"
                      ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
                      : rec?.result === "NG"
                        ? "border-red-400 bg-red-50 dark:bg-red-950"
                        : "border-amber-300 bg-white dark:border-amber-800 dark:bg-zinc-950"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold">{rec?.result === "OK" ? "☑" : "☐"} {r.code}</span>
                    <span
                      className={`ml-2 rounded px-1.5 text-xs ${
                        !isOperateCell(r, step)
                          ? r.states[step] === "close"
                            ? "border border-red-400 font-semibold text-red-600 dark:text-red-400"
                            : "border border-blue-400 font-semibold text-blue-600 dark:text-blue-400"
                          : r.states[step] === "close"
                            ? "bg-red-500 text-white"
                            : "bg-blue-600 text-white"
                      }`}
                    >
                      {actionText(r, step)}
                    </span>
                    <span className="block truncate text-xs text-zinc-500">{r.name}</span>
                    {r.note && <span className="block text-xs font-medium text-amber-700">※{r.note}</span>}
                    {rec?.confirmedAt && <span className="text-[11px] text-green-700">制御室確認済み</span>}
                    {r.nodeId && <span className="block text-[11px] text-sky-600">📍 タップで図面上の位置を表示</span>}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCode(r.code, false);
                    }}
                    className="shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                  >
                    {rec?.result === "OK" ? "記録済" : "記録"}
                  </button>
                </div>
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
                <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">操作した内容を選択してください。</p>
                {choiceError && (
                  <p className="mt-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white">{choiceError}</p>
                )}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button onClick={() => setPending(null)} className="rounded-lg border border-zinc-300 py-3 text-sm">
                    キャンセル
                  </button>
                  <button
                    onClick={() => choose(pending, "close")}
                    className="rounded-lg bg-red-500 py-3 text-base font-bold text-white hover:bg-red-600"
                  >
                    閉操作
                  </button>
                  <button
                    onClick={() => choose(pending, "open")}
                    className="rounded-lg bg-emerald-600 py-3 text-base font-bold text-white hover:bg-emerald-500"
                  >
                    開操作
                  </button>
                </div>
                <button
                  onClick={() => {
                    record(pending, "NG");
                    setPending(null);
                  }}
                  className="mt-3 w-full text-center text-xs text-zinc-500 underline"
                >
                  バルブが操作できない等の異常を報告（NG）
                </button>
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
  onLocate,
}: {
  plan: SavedPlan;
  exec: Execution;
  onTap: (r: PlanRow) => void;
  onLocate: (nodeId: string) => void;
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
                {r.nodeId ? (
                  <button onClick={() => onLocate(r.nodeId!)} className="text-left font-medium text-sky-700 hover:underline dark:text-sky-400" title="図面上の位置を表示">
                    📍 {r.code}
                  </button>
                ) : (
                  <p className="font-medium">{r.code}</p>
                )}
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

function safeDecode(t: string) {
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

// 全角・半角、大文字・小文字の違いを無視して検索する
function normalize(t: string) {
  return t.normalize("NFKC").toLowerCase();
}

const ROLE_MARK: Record<RowRole, NodeMark> = {
  boundary: "boundary",
  internal: "internal",
  drain: "drain",
  gauge: "gauge",
  fill: "fill",
  imported: "selected",
};

// チェックリスト（と点検記録）のプレビュー：図面で範囲と対象バルブ、表で工程ごとの開閉を確認する
function PlanPreview({
  graph,
  plan,
  exec,
  base,
  onClose,
  onStart,
  startLabel,
  onDelete,
  deleteLabel,
}: {
  graph: Graph;
  plan: SavedPlan;
  exec?: Execution;
  base: Record<string, ValveState>;
  onClose: () => void;
  onStart?: () => void;
  startLabel: string;
  onDelete: () => void;
  deleteLabel: string;
}) {
  const diagramRef = useRef<DiagramHandle>(null);
  // 表示する工程（点検中なら現在の工程から）
  const [step, setStep] = useState(exec && exec.status === "in_progress" ? exec.currentStep : 0);

  // 作業エリア（抜取範囲と、表示中の工程で操作する弁。作業前はラインナップの対象弁）に合わせて拡大する。
  // 工程を切り替えるたびに合わせ直す（充填では充填元弁まで、ラインナップでは範囲付近だけ）
  const areaIdsRef = useRef<string[]>([]);
  useEffect(() => {
    areaIdsRef.current = [
      ...plan.regionNodeIds,
      ...plan.rows
        .filter((r) => r.states[step === 0 ? Math.min(1, plan.steps.length - 1) : step])
        .map((r) => r.nodeId)
        .filter((id): id is string => !!id),
    ];
  });
  useEffect(() => {
    const t = setTimeout(() => diagramRef.current?.fitNodes(areaIdsRef.current), 80);
    return () => clearTimeout(t);
  }, [plan.id, step]);

  // その工程を終えた時点の弁状態と、その工程での燃料の流れ
  const valveState = stateAtStep(base, plan.rows, step);
  const flow = stepFlow(graph, plan, step, valveState);
  const layers: PipeLayer[] = [
    { key: "region", pipeIds: plan.regionPipeIds, color: "#ef4444", opacity: flow ? 0.2 : 0.4 },
    { key: "seal", pipeIds: plan.sealPipeIds, color: "#f59e0b", opacity: 0.3 },
  ];
  if (flow) {
    layers.push({
      key: `flow-${step}`,
      pipeIds: [...flow.directions.keys()],
      directions: flow.directions,
      color: flow.kind === "drain" ? "#0284c7" : "#0d9488",
      width: 6,
      flow: true,
    });
  }

  // その工程で操作する弁：開操作＝緑、閉操作＝赤、状態が変わらない確認＝水色
  const opened: PlanRow[] = [];
  const closed: PlanRow[] = [];
  const confirmed: PlanRow[] = [];
  plan.rows.forEach((r) => {
    if (!r.states[step] || step === 0) return;
    if (!isOperateCell(r, step)) confirmed.push(r);
    else if (r.states[step] === "open") opened.push(r);
    else closed.push(r);
  });
  const marks: Record<string, NodeMark> =
    step === 0
      ? Object.fromEntries(plan.rows.filter((r) => r.nodeId).map((r) => [r.nodeId!, ROLE_MARK[r.role]]))
      : Object.fromEntries([
          ...confirmed.filter((r) => r.nodeId).map((r) => [r.nodeId!, "selected" as NodeMark]),
          ...opened.filter((r) => r.nodeId).map((r) => [r.nodeId!, "internal" as NodeMark]),
          ...closed.filter((r) => r.nodeId).map((r) => [r.nodeId!, "boundary" as NodeMark]),
        ]);
  const codes = (rows: PlanRow[]) => rows.map((r) => r.code + (r.note ? "※" : "")).join("、");
  const label = (id: string) => graph.nodeById.get(id)?.label || "移送系統（移送ポンプ吐出）";
  const done = exec ? Object.values(exec.records).filter((r) => r.result === "OK").length : 0;
  const total = plan.rows.reduce((a, r) => a + r.states.filter((s, i) => s && i > 0).length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-500">
              {exec ? (exec.status === "completed" ? "完了した点検" : "点検中") : "チェックリスト"}のプレビュー
            </p>
            <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-50">{plan.name}</h2>
            <p className="text-xs text-zinc-500">
              {plan.source === "excel" ? "Excel取込" : plan.purpose} ・ {plan.steps.length}工程 ・ {plan.rows.length}弁
              {plan.summary.volumeL ? ` ・ 抜取量 ${formatLiters(plan.summary.volumeL)}` : ""}
              {plan.summary.drainMinutes ? ` ・ 抜取 ${formatMinutes(plan.summary.drainMinutes)}` : ""}
              {plan.summary.fillMinutes ? ` ・ 充填 ${formatMinutes(plan.summary.fillMinutes)}` : ""}
              {exec ? ` ・ 記録 ${done}/${total}` : ""}
              {exec && exec.status === "in_progress" ? ` ・ 現在工程：${plan.steps[exec.currentStep]}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700" aria-label="閉じる">
            ✕
          </button>
        </div>

        <div className="space-y-3 overflow-auto p-4">
          {plan.summary.warnings.length > 0 && (
            <ul className="list-disc rounded-lg bg-amber-50 py-2 pl-8 pr-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {plan.summary.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {/* 工程の切り替え */}
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => setStep(Math.max(0, step - 1))}
              disabled={step === 0}
              className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm disabled:opacity-30 dark:border-zinc-700"
              aria-label="前の工程"
            >
              ◀
            </button>
            {plan.steps.map((st, i) => (
              <button
                key={st}
                onClick={() => setStep(i)}
                className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${
                  i === step
                    ? "bg-zinc-800 font-semibold text-white dark:bg-zinc-200 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300"
                }`}
              >
                {i === 0 ? st : `${i}. ${st}`}
                {exec?.status === "in_progress" && i === exec.currentStep && <span className="ml-1 text-amber-500">●</span>}
              </button>
            ))}
            <button
              onClick={() => setStep(Math.min(plan.steps.length - 1, step + 1))}
              disabled={step === plan.steps.length - 1}
              className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm disabled:opacity-30 dark:border-zinc-700"
              aria-label="次の工程"
            >
              ▶
            </button>
          </div>

          {/* その工程の内容（状態遷移と流れ） */}
          <div className="grid gap-2 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800 sm:grid-cols-2">
            {step === 0 ? (
              <p className="text-zinc-600 dark:text-zinc-400 sm:col-span-2">
                作業前の状態です。図面の弁は作業前の開閉（緑＝開、赤＝閉）、リングはチェックリストの対象弁（区分別）を表します。
              </p>
            ) : (
              <>
                <div className="space-y-1">
                  <p>
                    <span className="mr-1 inline-block rounded bg-red-500 px-1.5 text-white">閉操作</span>
                    {codes(closed) || "なし"}
                  </p>
                  <p>
                    <span className="mr-1 inline-block rounded bg-emerald-500 px-1.5 text-white">開操作</span>
                    {codes(opened) || "なし"}
                  </p>
                  <p>
                    <span className="mr-1 inline-block rounded bg-cyan-500 px-1.5 text-white">確認</span>
                    {codes(confirmed) || "なし"}
                  </p>
                </div>
                <div className="text-zinc-600 dark:text-zinc-400">
                  {flow?.kind === "drain" && (
                    <p>
                      <span className="mr-1 inline-block rounded bg-sky-600 px-1.5 text-white">流れ</span>
                      範囲内の燃料を {flow.origins.map(label).join("・")} へ抜き取ります（矢印＝流れ方向）。
                    </p>
                  )}
                  {flow?.kind === "fill" && (
                    <p>
                      <span className="mr-1 inline-block rounded bg-teal-600 px-1.5 text-white">流れ</span>
                      {flow.origins.map(label).join("・")} から範囲内へ充填します（矢印＝流れ方向）。
                    </p>
                  )}
                  {!flow && <p>この工程では燃料の移動はありません（弁の開閉のみ）。</p>}
                  {[...closed, ...opened].some((r) => r.note) && <p className="mt-1 text-amber-700">※ {[...closed, ...opened].find((r) => r.note)?.note}</p>}
                </div>
              </>
            )}
          </div>

          <PipingDiagram
            ref={diagramRef}
            graph={graph}
            valveState={valveState}
            layers={layers}
            marks={marks}
            height="42vh"
            toolbar={
              <button
                onClick={() => diagramRef.current?.fitNodes(areaIdsRef.current)}
                className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
              >
                作業エリアを表示
              </button>
            }
          />
          <DiagramLegend
            items={[
              { color: "#22c55e", label: "開操作", kind: "ring" },
              { color: "#dc2626", label: "閉操作", kind: "ring" },
              { color: "#06b6d4", label: "確認（状態変化なし）", kind: "ring" },
              { color: "#0284c7", label: "抜取の流れ" },
              { color: "#0d9488", label: "充填の流れ" },
              { color: "#ef4444", label: "点検範囲" },
            ]}
          />
          <div className="overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-xs">
              <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">バルブ</th>
                  <th className="px-2 text-left font-medium">区分</th>
                  {plan.steps.map((st, i) => (
                    <th
                      key={st}
                      onClick={() => setStep(i)}
                      className={`cursor-pointer px-2 text-center font-medium ${
                        i === step ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      }`}
                    >
                      {st}
                      {exec?.status === "in_progress" && i === exec.currentStep && <span className="ml-0.5 text-amber-500">●</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={r.code} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-2 py-1">
                      {r.nodeId ? (
                        <button onClick={() => diagramRef.current?.focusNode(r.nodeId!)} className="text-left text-sky-700 hover:underline dark:text-sky-400">
                          📍 {r.code}
                        </button>
                      ) : (
                        r.code
                      )}
                      <span className="block text-[11px] text-zinc-500">{r.name}</span>
                    </td>
                    <td className="px-2 text-zinc-500">{ROLE_LABEL[r.role]}</td>
                    {r.states.map((st, i) => {
                      const rec = exec?.records[recordKey(i, r.code)];
                      return (
                        <td key={i} className={`px-2 text-center ${i === step ? "bg-zinc-100 dark:bg-zinc-900" : ""}`}>
                          <span
                            className={`inline-block min-w-6 rounded px-1 ${
                              !st
                                ? "text-zinc-300 dark:text-zinc-700"
                                : rec?.result === "NG"
                                  ? "bg-red-700 text-white"
                                  : isOperateCell(r, i) && i > 0
                                    ? st === "open"
                                      ? "bg-emerald-500 text-white"
                                      : "bg-red-500 text-white"
                                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                            }`}
                          >
                            {stateGlyph(st)}
                            {exec && st && i > 0 ? (rec?.result === "OK" ? "☑" : "☐") : ""}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <button
            onClick={onDelete}
            className="mr-auto rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:text-red-400"
          >
            {deleteLabel}
          </button>
          <button onClick={onClose} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700">
            閉じる
          </button>
          {onStart && (
            <button onClick={onStart} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600">
              {startLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
