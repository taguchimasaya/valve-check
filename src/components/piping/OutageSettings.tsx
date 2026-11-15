"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import PipingDiagram, { type NodeMark } from "@/components/piping/PipingDiagram";
import { normalValveState, type Graph } from "@/lib/piping/graph";
import { KIND_LABEL } from "@/lib/piping/diagramData";
import { defaultsAsSettings, rangeOfDef, settingToDef, type OutageSetting } from "@/lib/piping/outages";
import { OUTAGE_COLOR } from "@/lib/piping/live";
import type { PipingStore, StoreAction } from "@/lib/piping/store";
import type { NodeKind } from "@/lib/piping/types";

// 運用停止範囲の設定（③ 制御室の中から開く）：制御室で「停止」にできる範囲を拠点ごとに登録する。
// 範囲は「区画まるごと」＋「個別に足す機器」−「外す機器」で決める。図面の機器をクリックして足す・外す。
// 保存先は piping_store の outageDefs（拠点ごと）。登録が無ければ既定の範囲を使う。

const ALL_KINDS = Object.keys(KIND_LABEL) as NodeKind[];

const newKey = () => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Props = {
  g: Graph;
  facilityId: string;
  store: PipingStore | null;
  act: (a: StoreAction) => Promise<PipingStore>;
  onClose: () => void;
};

export default function OutageSettings({ g, facilityId, store, act, onClose }: Props) {
  const info = { facilityId };
  const [draft, setDraft] = useState<OutageSetting[] | null>(null);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 登録済みの範囲（無ければ既定の範囲を編集できる形にしたもの）
  const saved = useMemo(
    () => (store ? (store.outageDefs?.length ? store.outageDefs : defaultsAsSettings(info.facilityId, g)) : null),
    [store, info.facilityId, g]
  );
  const usingDefaults = !!store && !store.outageDefs?.length;
  useEffect(() => {
    if (saved && draft === null) {
      const t = setTimeout(() => {
        setDraft(saved);
        setSelKey(saved[0]?.key ?? null);
      }, 0);
      return () => clearTimeout(t);
    }
  }, [saved, draft]);
  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

  const sel = draft?.find((d) => d.key === selKey) ?? null;
  const update = (patch: Partial<OutageSetting>) => setDraft((ds) => ds && ds.map((d) => (d.key === selKey ? { ...d, ...patch } : d)));

  const range = useMemo(() => (sel ? rangeOfDef(g, settingToDef(sel)) : null), [g, sel]);
  const inRange = useMemo(() => new Set(range?.nodeIds ?? []), [range]);
  const valveState = useMemo(() => normalValveState(g.facility), [g]);

  // 区画の一覧（機器の区画欄から）
  const areas = useMemo(() => {
    const m = new Map<string, number>();
    g.facility.nodes.forEach((n) => n.kind !== "junction" && m.set(n.area, (m.get(n.area) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"));
  }, [g]);

  const marks = useMemo(() => {
    const m: Record<string, NodeMark> = {};
    if (!sel) return m;
    range?.nodeIds.forEach((id) => {
      if (g.nodeById.get(id)?.kind !== "junction") m[id] = sel.nodes.includes(id) ? "selected" : "internal";
    });
    sel.exclude.forEach((id) => g.nodeById.has(id) && (m[id] = "boundary"));
    return m;
  }, [sel, range, g]);

  /** 機器のクリック：範囲に入っていれば外し、入っていなければ足す */
  function toggleNode(id: string) {
    if (!sel) return;
    if (inRange.has(id)) {
      // 区画で入っている機器は「外す」に入れ、個別に足した機器は足したのをやめる
      const byArea = sel.areas.includes(g.nodeById.get(id)?.area ?? "");
      update({ nodes: sel.nodes.filter((x) => x !== id), exclude: byArea ? [...sel.exclude, id] : sel.exclude });
    } else if (sel.exclude.includes(id)) update({ exclude: sel.exclude.filter((x) => x !== id) });
    else update({ nodes: [...sel.nodes, id] });
  }

  function addDef() {
    const d: OutageSetting = { key: newKey(), label: "新しい停止範囲", areas: [], nodes: [], exclude: [] };
    setDraft((ds) => [...(ds ?? []), d]);
    setSelKey(d.key);
  }

  function removeDef() {
    if (!sel || !confirm(`停止範囲「${sel.label}」を消しますか？（保存するまでは元に戻せます）`)) return;
    setDraft((ds) => {
      const next = (ds ?? []).filter((d) => d.key !== sel.key);
      setSelKey(next[0]?.key ?? null);
      return next;
    });
  }

  function move(dir: -1 | 1) {
    setDraft((ds) => {
      if (!ds) return ds;
      const i = ds.findIndex((d) => d.key === selKey);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ds.length) return ds;
      const next = [...ds];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save(defs: OutageSetting[], text: string) {
    const bad = defs.find((d) => !d.label.trim());
    if (bad) return setMessage({ type: "err", text: "名前が空欄の停止範囲があります" });
    const dup = defs.find((d, i) => defs.findIndex((e) => e.label.trim() === d.label.trim()) !== i);
    if (dup) return setMessage({ type: "err", text: `停止範囲の名前「${dup.label}」が重複しています` });
    setBusy(true);
    try {
      const s = await act({ action: "setOutageDefs", defs });
      const next = s.outageDefs?.length ? s.outageDefs : defaultsAsSettings(info.facilityId, g);
      setDraft(next);
      if (!next.some((d) => d.key === selKey)) setSelKey(next[0]?.key ?? null);
      setMessage({ type: "ok", text });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  // 系統図に無い機器（設備更新で無くなった機器など）
  const missing = sel ? [...sel.nodes, ...sel.exclude].filter((id) => !g.nodeById.has(id)) : [];
  const missingAreas = sel ? sel.areas.filter((a) => !areas.some(([x]) => x === a)) : [];
  const activeKeys = new Set((store?.outages ?? []).map((o) => o.key));

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-zinc-50 px-4 py-4 dark:bg-black">
      <div className="mx-auto max-w-[1600px] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">運用停止範囲の設定</h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              制御室で「停止」にできる範囲を拠点ごとに登録します。範囲は「区画まるごと」に、図面でクリックした機器を足したり外したりして決めます。
              {usingDefaults && " 今は既定の範囲を使っています（保存すると、この拠点の設定として登録されます）。"}
            </p>
          </div>
          <button
            onClick={() => (!dirty || confirm("保存していない変更があります。閉じますか？")) && onClose()}
            className="rounded-lg border border-zinc-300 px-4 py-1.5 text-sm dark:border-zinc-700"
          >
            制御室に戻る
          </button>
        </div>

        {message && (
          <p
            className={`rounded-lg px-3 py-2 text-sm ${
              message.type === "ok" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
            }`}
          >
            {message.text}
          </p>
        )}

        {!draft ? (
          <p className="text-sm text-zinc-500">読み込み中…</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
            <aside className="space-y-3">
              <Panel title={`停止範囲（${draft.length}件）`}>
                <div className="space-y-1">
                  {draft.map((d) => (
                    <button
                      key={d.key}
                      onClick={() => setSelKey(d.key)}
                      className={`block w-full rounded-lg border px-2 py-1.5 text-left text-sm ${
                        d.key === selKey ? "border-slate-700 bg-slate-700 text-white" : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                      }`}
                    >
                      {d.label || "（名前なし）"}
                      {activeKeys.has(d.key) && <span className="ml-1 rounded bg-amber-400 px-1 text-[10px] text-zinc-900">停止中</span>}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1 text-xs">
                  <SmallBtn onClick={addDef}>＋ 追加</SmallBtn>
                  <SmallBtn onClick={() => move(-1)} disabled={!sel}>
                    ↑
                  </SmallBtn>
                  <SmallBtn onClick={() => move(1)} disabled={!sel}>
                    ↓
                  </SmallBtn>
                  <SmallBtn onClick={removeDef} disabled={!sel} danger>
                    削除
                  </SmallBtn>
                </div>
              </Panel>

              {sel && (
                <Panel title="範囲の内容">
                  <div className="space-y-2 text-sm">
                    <label className="block">
                      <span className="text-xs text-zinc-500">名前（制御室のボタン）</span>
                      <input value={sel.label} onChange={(e) => update({ label: e.target.value })} className={inputCls} />
                    </label>
                    <label className="block">
                      <span className="text-xs text-zinc-500">説明（省略可）</span>
                      <input value={sel.desc ?? ""} onChange={(e) => update({ desc: e.target.value })} className={inputCls} />
                    </label>
                    <div>
                      <p className="text-xs text-zinc-500">区画まるごと含める</p>
                      <div className="mt-1 max-h-48 space-y-0.5 overflow-auto">
                        {areas.map(([a, n]) => (
                          <label key={a} className="flex items-center gap-1.5 text-xs">
                            <input
                              type="checkbox"
                              checked={sel.areas.includes(a)}
                              onChange={(e) => update({ areas: e.target.checked ? [...sel.areas, a] : sel.areas.filter((x) => x !== a) })}
                            />
                            {a}
                            <span className="text-zinc-400">（{n}）</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <label className="flex items-start gap-1.5 text-xs">
                      <input type="checkbox" checked={!!sel.toJunctions} onChange={(e) => update({ toJunctions: e.target.checked })} className="mt-0.5" />
                      範囲の機器から隣の分岐点までの配管も含める（共通の配管から分かれる系統など）
                    </label>
                    <NodeChips title="個別に足した機器" ids={sel.nodes} onRemove={(id) => update({ nodes: sel.nodes.filter((x) => x !== id) })} />
                    <NodeChips title="区画から外した機器" ids={sel.exclude} onRemove={(id) => update({ exclude: sel.exclude.filter((x) => x !== id) })} />
                    {(missing.length > 0 || missingAreas.length > 0) && (
                      <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                        今の系統図に無い{missingAreas.length ? `区画（${missingAreas.join("・")}）` : ""}
                        {missing.length ? `機器（${missing.join("・")}）` : ""}が入っています。設備更新で無くなった場合は外してください。
                      </p>
                    )}
                    <p className="text-xs text-zinc-500">
                      範囲：機器 {range?.nodeIds.filter((id) => g.nodeById.get(id)?.kind !== "junction").length ?? 0} 件・配管 {range?.pipeIds.length ?? 0} 本
                    </p>
                  </div>
                </Panel>
              )}

              <Panel title="保存">
                <button
                  onClick={() => save(draft, "運用停止範囲の設定を保存しました。制御室の停止ボタンに反映されます。")}
                  disabled={busy || !dirty}
                  className="w-full rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  {busy ? "保存中…" : "保存する"}
                </button>
                {dirty && (
                  <button onClick={() => setDraft(saved)} className="mt-1 text-xs text-zinc-500 underline">
                    変更を取り消す
                  </button>
                )}
                {!usingDefaults && (
                  <button
                    onClick={() =>
                      confirm("この拠点の設定を消して、既定の停止範囲に戻しますか？\n停止中の範囲のうち、既定に無いものは解除されます。") &&
                      save([], "既定の停止範囲に戻しました。")
                    }
                    disabled={busy}
                    className="mt-1 block text-xs text-zinc-500 underline"
                  >
                    既定の範囲に戻す
                  </button>
                )}
                <p className="mt-2 text-[11px] text-zinc-500">消した範囲で停止中のものは、保存すると解除されます。</p>
              </Panel>
            </aside>

            <div className="min-w-0 space-y-2">
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                図面の機器をクリックすると、範囲に足す／外すを切り替えます。
                <span className="ml-2 inline-block h-2 w-2 rounded-full border-2 border-green-600" /> 区画で含めた機器
                <span className="ml-2 inline-block h-2 w-2 rounded-full border-2 border-cyan-500" /> 個別に足した機器
                <span className="ml-2 inline-block h-2 w-2 rounded-full border-2 border-red-600" /> 外した機器
              </p>
              <PipingDiagram
                graph={g}
                valveState={valveState}
                layers={range ? [{ key: "range", pipeIds: range.pipeIds, color: OUTAGE_COLOR, width: 7, opacity: 0.45 }] : []}
                boxes={range && range.nodeIds.length ? [{ key: "box", ...range.box, label: sel?.label ?? "", color: OUTAGE_COLOR }] : []}
                marks={marks}
                onNodeClick={toggleNode}
                clickableKinds={ALL_KINDS}
                height="calc(100vh - 200px)"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NodeChips({ title, ids, onRemove }: { title: string; ids: string[]; onRemove: (id: string) => void }) {
  if (!ids.length) return null;
  return (
    <div>
      <p className="text-xs text-zinc-500">
        {title}（{ids.length}）
      </p>
      <div className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-auto">
        {ids.map((id) => (
          <button key={id} onClick={() => onRemove(id)} title="外す" className="rounded border border-zinc-300 px-1.5 py-0.5 font-mono text-[11px] hover:bg-red-50 dark:border-zinc-700">
            {id} ×
          </button>
        ))}
      </div>
    </div>
  );
}

const inputCls = "mt-0.5 w-full rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700";

function SmallBtn({ onClick, disabled, danger, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2 py-0.5 disabled:opacity-40 ${danger ? "border-red-300 text-red-700 dark:border-red-900 dark:text-red-400" : "border-zinc-300 dark:border-zinc-700"}`}
    >
      {children}
    </button>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</h2>
      {children}
    </section>
  );
}
