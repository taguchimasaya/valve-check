"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import PipingDiagram, { DiagramLegend, type NodeMark, type PipeLayer } from "@/components/piping/PipingDiagram";
import { newId } from "@/lib/piping/checklist";
import { execView, planConflicts } from "@/lib/piping/execution";
import {
  applyOperations,
  describeOperation,
  OPERATION_META,
  TANKS,
  type Operation,
  type OperationKind,
} from "@/lib/piping/operations";
import { recordKey, type Execution } from "@/lib/piping/store";
import { useGraph, usePipingStore } from "@/lib/piping/usePiping";
import { isStepCompleteAudioEnabled, isValveActionAudioEnabled, speak } from "@/lib/audioSettings";

type Draft = {
  kind: OperationKind;
  system: "A" | "B";
  pumpSystem: 1 | 2;
  tank: string;
  tanks: string[];
  fromTank: string;
  toTank: string;
  strainers: number[];
  filters: number[];
  pumps: number[];
};

const INITIAL_DRAFT: Draft = {
  kind: "issue",
  system: "A",
  pumpSystem: 1,
  tank: "T-101",
  tanks: ["T-101"],
  fromTank: "T-101",
  toTank: "T-102",
  strainers: [1],
  filters: [1, 2, 3],
  pumps: [1, 2],
};

function draftToOperation(d: Draft): Operation {
  const id = newId();
  switch (d.kind) {
    case "receive":
      return { id, kind: "receive", system: d.system, tank: d.tank, strainers: d.strainers, filters: d.filters };
    case "issue":
      return { id, kind: "issue", tanks: d.tanks, system: d.pumpSystem, pumps: d.pumps };
    case "transfer":
      return { id, kind: "transfer", fromTank: d.fromTank, toTank: d.toTank, pumps: d.pumps.filter((p) => p <= 2) };
    case "bypass":
      return { id, kind: "bypass", fromTank: d.fromTank, toTank: d.toTank, system: d.pumpSystem, pumps: d.pumps };
  }
}

export default function ControlPage() {
  const g = useGraph();
  const { store, act, error } = usePipingStore(1000);
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [hidden, setHidden] = useState<string[]>([]);
  const [opError, setOpError] = useState<string | null>(null);

  const operations = useMemo(() => store?.operations ?? [], [store?.operations]);
  const opState = useMemo(() => applyOperations(g, operations), [g, operations]);
  const running = (store?.executions ?? []).filter((e) => e.status === "in_progress");
  const shown = running.filter((e) => !hidden.includes(e.id));

  // ───── 図面に重ねる表示 ─────
  // 点検ライン（太い赤・点滅）を下地に、運用ライン（細い流れ表示）を上に重ねる
  const inspLayers: PipeLayer[] = [];
  const opLayers: PipeLayer[] = [];
  opState.routes.forEach((r) => {
    if (r.error) return;
    opLayers.push({ key: `op-${r.op.id}`, pipeIds: r.pipeIds, color: OPERATION_META[r.op.kind].color, width: 5, flow: true });
  });
  // 運用状態に、点検中作業の操作記録を順に重ねる
  let valveState = opState.valveState;
  const marks: Record<string, NodeMark> = {};
  const markOwner = new Map<string, { exec: Execution; step: number; code: string }>();
  const views: { exec: Execution; v: ReturnType<typeof execView>; conflicts: string[] }[] = [];
  for (const e of shown) {
    const plan = store!.plans.find((p) => p.id === e.planId);
    if (!plan) continue;
    const v = execView(plan, e, valveState);
    valveState = v.valveState;
    inspLayers.push({ key: `insp-${e.id}`, pipeIds: plan.regionPipeIds, color: "#ef4444", width: 13, opacity: 0.6, blink: true });
    for (const [id, m] of Object.entries(v.marks)) {
      marks[id] = m;
      const row = plan.rows.find((r) => r.nodeId === id);
      if (row) markOwner.set(id, { exec: e, step: e.currentStep, code: row.code });
    }
    views.push({ exec: e, v, conflicts: planConflicts(plan, opState, (k) => OPERATION_META[k as OperationKind].label) });
  }

  const layers = [...inspLayers, ...opLayers];

  // ───── 新着の音声通知 ─────
  const seenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!store) return;
    const all = store.executions.flatMap((e) => e.events.map((ev) => ({ key: `${e.id}|${ev.at}|${ev.text}`, ev, e })));
    if (!seenRef.current) {
      seenRef.current = new Set(all.map((a) => a.key));
      return;
    }
    all.forEach((a) => {
      if (seenRef.current!.has(a.key)) return;
      seenRef.current!.add(a.key);
      if (a.ev.type === "step" && isStepCompleteAudioEnabled()) speak(`${a.e.planName}、${a.ev.text}`);
      if (a.ev.type === "valve" && isValveActionAudioEnabled()) speak(a.ev.text);
    });
  }, [store]);

  async function addOperation() {
    const op = draftToOperation(draft);
    const sameAs = (o: Operation) => JSON.stringify({ ...o, id: "" }) === JSON.stringify({ ...op, id: "" });
    if (operations.some(sameAs)) {
      setOpError("同じ運用がすでに入力されています");
      return;
    }
    const trial = applyOperations(g, [...operations, op]);
    const err = trial.routes.find((r) => r.op.id === op.id)?.error;
    if (err) {
      setOpError(err);
      return;
    }
    setOpError(null);
    await act({ action: "setOperations", operations: [...operations, op] });
  }

  function confirmValve(id: string) {
    const o = markOwner.get(id);
    if (!o) return;
    const rec = o.exec.records[recordKey(o.step, o.code)];
    if (rec?.result === "OK" && !rec.confirmedAt) {
      act({ action: "confirm", execId: o.exec.id, step: o.step, code: o.code });
    }
  }

  const toggle = (arr: number[], n: number) => (arr.includes(n) ? arr.filter((x) => x !== n) : [...arr, n].sort());

  return (
    <main className="min-h-screen bg-zinc-100 px-3 py-4 dark:bg-black">
      <div className="mx-auto max-w-[1900px]">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← 配管系統図メニュー
          </Link>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">③ 制御室（図面ビュー）</h1>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[320px_1fr_360px]">
          {/* 運用入力 */}
          <aside className="space-y-3">
            <Panel title="運用の入力">
              <div className="grid grid-cols-4 gap-1">
                {(Object.keys(OPERATION_META) as OperationKind[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setDraft({ ...draft, kind: k, pumps: k === "transfer" ? [1] : draft.pumps })}
                    className={`rounded-md py-1.5 text-xs font-medium ${draft.kind === k ? "text-white" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}
                    style={draft.kind === k ? { background: OPERATION_META[k].color } : undefined}
                  >
                    {OPERATION_META[k].label}
                  </button>
                ))}
              </div>

              <div className="mt-3 space-y-2 text-sm">
                {draft.kind === "receive" && (
                  <>
                    <Field label="受入系統">
                      <Seg options={["A", "B"]} value={draft.system} onChange={(s) => setDraft({ ...draft, system: s as "A" | "B" })} />
                    </Field>
                    <Field label="受入タンク">
                      <TankSelect value={draft.tank} onChange={(t) => setDraft({ ...draft, tank: t })} />
                    </Field>
                    <Field label="ストレーナー">
                      <Checks options={[1, 2]} value={draft.strainers} onChange={(n) => setDraft({ ...draft, strainers: toggle(draft.strainers, n) })} />
                    </Field>
                    <Field label="フィルター">
                      <Checks options={[1, 2, 3]} value={draft.filters} onChange={(n) => setDraft({ ...draft, filters: toggle(draft.filters, n) })} />
                    </Field>
                  </>
                )}
                {draft.kind === "issue" && (
                  <>
                    <Field label="払出タンク">
                      <div className="grid grid-cols-6 gap-1">
                        {TANKS.map((t) => (
                          <button
                            key={t}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                tanks: draft.tanks.includes(t) ? draft.tanks.filter((x) => x !== t) : [...draft.tanks, t],
                              })
                            }
                            className={`rounded py-1 text-[11px] ${draft.tanks.includes(t) ? "bg-green-600 text-white" : "bg-zinc-100 dark:bg-zinc-800"}`}
                          >
                            {t.slice(2)}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="払出系統">
                      <Seg options={["1", "2"]} value={String(draft.pumpSystem)} onChange={(s) => setDraft({ ...draft, pumpSystem: Number(s) as 1 | 2 })} />
                    </Field>
                    <Field label="払出ポンプ">
                      <Checks options={[1, 2, 3]} value={draft.pumps} onChange={(n) => setDraft({ ...draft, pumps: toggle(draft.pumps, n) })} prefix={`P-${draft.pumpSystem}`} />
                    </Field>
                  </>
                )}
                {(draft.kind === "transfer" || draft.kind === "bypass") && (
                  <>
                    <Field label={draft.kind === "transfer" ? "移送元タンク" : "払出元タンク"}>
                      <TankSelect value={draft.fromTank} onChange={(t) => setDraft({ ...draft, fromTank: t })} />
                    </Field>
                    <Field label={draft.kind === "transfer" ? "移送先タンク" : "返油先タンク"}>
                      <TankSelect value={draft.toTank} onChange={(t) => setDraft({ ...draft, toTank: t })} />
                    </Field>
                    {draft.kind === "bypass" && (
                      <Field label="払出系統">
                        <Seg options={["1", "2"]} value={String(draft.pumpSystem)} onChange={(s) => setDraft({ ...draft, pumpSystem: Number(s) as 1 | 2 })} />
                      </Field>
                    )}
                    <Field label={draft.kind === "transfer" ? "移送ポンプ" : "払出ポンプ"}>
                      <Checks
                        options={draft.kind === "transfer" ? [1, 2] : [1, 2, 3]}
                        value={draft.pumps}
                        onChange={(n) => setDraft({ ...draft, pumps: toggle(draft.pumps, n) })}
                        prefix={draft.kind === "transfer" ? "TP-" : `P-${draft.pumpSystem}`}
                      />
                    </Field>
                  </>
                )}
              </div>
              {opError && <p className="mt-2 text-xs text-red-600">{opError}</p>}
              <button
                onClick={addOperation}
                className="mt-3 w-full rounded-lg py-2 text-sm font-semibold text-white"
                style={{ background: OPERATION_META[draft.kind].color }}
              >
                運用ラインを表示（追加）
              </button>
            </Panel>

            <Panel title={`現在の運用（${operations.length}）`}>
              {operations.length === 0 ? (
                <p className="text-sm text-zinc-400">運用中のラインはありません（待機状態）。</p>
              ) : (
                <ul className="space-y-2">
                  {opState.routes.map((r) => (
                    <li key={r.op.id} className="flex items-start gap-2 text-xs">
                      <span className="mt-0.5 h-3 w-3 shrink-0 rounded-sm" style={{ background: OPERATION_META[r.op.kind].color }} />
                      <div className="flex-1">
                        <p className="font-semibold">{OPERATION_META[r.op.kind].label}</p>
                        <p className="text-zinc-600 dark:text-zinc-400">{describeOperation(r.op)}</p>
                        {r.error ? (
                          <p className="text-red-600">{r.error}</p>
                        ) : (
                          <p className="text-zinc-400">開弁 {r.openValves.length}箇所</p>
                        )}
                      </div>
                      <button
                        onClick={() => act({ action: "setOperations", operations: operations.filter((o) => o.id !== r.op.id) })}
                        className="text-red-600"
                      >
                        終了
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {opState.conflicts.map((c) => (
                <p key={c} className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                  {c}
                </p>
              ))}
            </Panel>
          </aside>

          {/* 図面 */}
          <section className="min-w-0 space-y-2">
            <PipingDiagram
              graph={g}
              valveState={valveState}
              layers={layers}
              marks={marks}
              clickableKinds={["valve", "drain", "gauge"]}
              onNodeClick={confirmValve}
              height="80vh"
            />
            <DiagramLegend
              items={[
                ...(Object.keys(OPERATION_META) as OperationKind[]).map((k) => ({
                  color: OPERATION_META[k].color,
                  label: `${OPERATION_META[k].label}ライン`,
                })),
                { color: "#ef4444", label: "点検ライン（点滅）" },
                { color: "#f59e0b", label: "操作待ち（点滅）", kind: "blink" as const },
                { color: "#22c55e", label: "操作済み（点灯）※クリックで確認", kind: "ring" as const },
                { color: "#2563eb", label: "制御室確認済み", kind: "ring" as const },
              ]}
            />
          </section>

          {/* 点検状況 */}
          <aside className="space-y-3">
            <Panel title={`点検中の作業（${running.length}）`}>
              {running.length === 0 && <p className="text-sm text-zinc-400">点検中の作業はありません。</p>}
              <ul className="space-y-3">
                {running.map((e) => {
                  const vw = views.find((x) => x.exec.id === e.id);
                  const plan = store!.plans.find((p) => p.id === e.planId);
                  const unconfirmed = plan
                    ? plan.rows.filter((r) => {
                        const rec = e.records[recordKey(e.currentStep, r.code)];
                        return rec?.result === "OK" && !rec.confirmedAt;
                      })
                    : [];
                  const ng = plan ? plan.rows.filter((r) => e.records[recordKey(e.currentStep, r.code)]?.result === "NG") : [];
                  return (
                    <li key={e.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={!hidden.includes(e.id)}
                          onChange={(ev) => setHidden((h) => (ev.target.checked ? h.filter((x) => x !== e.id) : [...h, e.id]))}
                          title="図面に表示"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{e.planName}</p>
                          <p className="text-xs text-zinc-500">
                            工程：{plan?.steps[e.currentStep]}
                            {vw && `（${vw.v.done}/${vw.v.total}）`}
                            {vw?.v.stepComplete && <span className="ml-1 font-semibold text-emerald-600">完了</span>}
                          </p>
                        </div>
                      </div>
                      {vw && vw.conflicts.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {vw.conflicts.map((c) => (
                            <li key={c} className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300">
                              ⚠ {c}
                            </li>
                          ))}
                        </ul>
                      )}
                      {ng.length > 0 && (
                        <p className="mt-2 rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white">
                          NG報告：{ng.map((r) => r.code).join("、")}
                        </p>
                      )}
                      {unconfirmed.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs text-zinc-500">確認待ち</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {unconfirmed.map((r) => (
                              <button
                                key={r.code}
                                onClick={() => act({ action: "confirm", execId: e.id, step: e.currentStep, code: r.code })}
                                className="rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-500"
                              >
                                {r.code} 確認
                              </button>
                            ))}
                            {unconfirmed.length > 1 && (
                              <button
                                onClick={async () => {
                                  for (const r of unconfirmed) {
                                    await act({ action: "confirm", execId: e.id, step: e.currentStep, code: r.code });
                                  }
                                }}
                                className="rounded border border-emerald-600 px-2 py-0.5 text-xs text-emerald-700"
                              >
                                すべて確認
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Panel>

            <Panel title="通知">
              <ul className="max-h-[45vh] space-y-1 overflow-auto text-xs">
                {running
                  .flatMap((e) => e.events.map((ev) => ({ ev, name: e.planName })))
                  .sort((a, b) => b.ev.at.localeCompare(a.ev.at))
                  .slice(0, 40)
                  .map(({ ev, name }, i) => (
                    <li
                      key={`${ev.at}-${i}`}
                      className={`rounded px-2 py-1 ${ev.type === "step" ? "bg-emerald-100 font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-zinc-50 dark:bg-zinc-900"}`}
                    >
                      <span className="text-zinc-400">{new Date(ev.at).toLocaleTimeString("ja-JP")}</span> {name}：{ev.text}
                    </li>
                  ))}
              </ul>
            </Panel>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs text-zinc-500">{label}</p>
      {children}
    </div>
  );
}

function Seg({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} className={`flex-1 py-1 text-xs ${value === o ? "bg-zinc-800 text-white" : ""}`}>
          {o}
        </button>
      ))}
    </div>
  );
}

function Checks({
  options,
  value,
  onChange,
  prefix = "",
}: {
  options: number[];
  value: number[];
  onChange: (n: number) => void;
  prefix?: string;
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`flex-1 rounded-md py-1 text-xs ${value.includes(o) ? "bg-zinc-800 text-white" : "bg-zinc-100 dark:bg-zinc-800"}`}
        >
          {prefix}
          {o}
        </button>
      ))}
    </div>
  );
}

function TankSelect({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
    >
      {TANKS.map((t) => (
        <option key={t}>{t}</option>
      ))}
    </select>
  );
}
