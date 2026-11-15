"use client";

import { useMemo } from "react";
import { KIND_LABEL } from "@/lib/piping/diagramData";
import type { Graph } from "@/lib/piping/graph";
import { selectNodes, type FlushParts, type IsoParts } from "@/lib/piping/ruleBlocks";
import type { FireParts } from "@/lib/piping/fireTest";
import { BASIC_RELATIONS, needsCalc, newBlock, newRuleId, RELATION_LABEL, type BlockRelation, type BlockSelector, type RuleBlock } from "@/lib/piping/rules";
import { FLUID_LABEL, type Fluid, type NodeKind, type ValveState } from "@/lib/piping/types";

// ルールブロックの編集（ノーコード）：「もし（条件）なら → 工程ごとに 開／閉」をカードで組み立てる。

const ROW_KIND_OPTIONS: NodeKind[] = ["valve", "drain", "gauge", "pump", "transferPump"];
const FLUIDS: Fluid[] = ["fuel", "water", "foam", "foamSolution", "other"];
const card = "rounded-lg border border-zinc-200 p-3 dark:border-zinc-800";
const input = "rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700";

export function useAreas(g: Graph) {
  return useMemo(() => [...new Set(g.facility.nodes.map((n) => n.area).filter(Boolean))].sort(), [g]);
}

/** 機器の条件の入力欄（ルールブロック・作業の経路の起点で共通） */
export function SelectorFields({
  sel,
  onChange,
  areas,
  relations = true,
  relationList = BASIC_RELATIONS,
  rowKinds = ROW_KIND_OPTIONS,
}: {
  sel: BlockSelector;
  onChange: (s: BlockSelector) => void;
  areas: string[];
  relations?: boolean;
  /** 選べる「対象との関係」（計算の部品を使うときは、その結果の関係も入る） */
  relationList?: BlockRelation[];
  rowKinds?: NodeKind[];
}) {
  const set = (patch: Partial<BlockSelector>) => onChange({ ...sel, ...patch });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const branch = ["targetBranch", "routeBranch", "isoBoundary", "isoFillLine", "isoFillCrack", "flushSide", "fireOutside"].includes(sel.relation);
  // 今の設定が一覧に無い関係でも、消えないように選択肢に残す
  const options = relationList.includes(sel.relation) ? relationList : [...relationList, sel.relation];
  return (
    <div className="grid gap-2 text-sm sm:grid-cols-[120px_1fr] sm:items-center">
      {relations && (
        <>
          <span className="text-xs text-zinc-500">対象との関係</span>
          <div className="flex flex-wrap items-center gap-2">
            <select value={sel.relation} onChange={(e) => set({ relation: e.target.value as BlockRelation })} className={input}>
              {options.map((r) => (
                <option key={r} value={r}>
                  {RELATION_LABEL[r]}
                  {!relationList.includes(r) ? "（この作業では使えません）" : ""}
                </option>
              ))}
            </select>
            {branch && (
              <select
                value={sel.depth}
                onChange={(e) => set({ depth: Number(e.target.value) as 1 | 2 })}
                className={input}
                title="仕切る弁の数"
              >
                <option value={1}>1ブロック（最初の弁だけ）</option>
                <option value={2}>2ブロック（その外側の弁まで）</option>
              </select>
            )}
          </div>
        </>
      )}
      <span className="text-xs text-zinc-500">機器の種類</span>
      <div className="flex flex-wrap gap-1">
        {rowKinds.map((k) => (
          <Chip key={k} on={sel.kinds.includes(k)} onClick={() => set({ kinds: toggle(sel.kinds, k) })}>
            {KIND_LABEL[k]}
          </Chip>
        ))}
        {!sel.kinds.length && <span className="text-xs text-zinc-400">（未選択なら仕切弁）</span>}
      </div>
      <span className="text-xs text-zinc-500">流体</span>
      <div className="flex flex-wrap gap-1">
        {FLUIDS.map((f) => (
          <Chip key={f} on={sel.fluids.includes(f)} onClick={() => set({ fluids: toggle(sel.fluids, f) })}>
            {FLUID_LABEL[f]}
          </Chip>
        ))}
        {!sel.fluids.length && <span className="text-xs text-zinc-400">（未選択なら指定なし）</span>}
      </div>
      <span className="text-xs text-zinc-500">区画</span>
      <select value={sel.area} onChange={(e) => set({ area: e.target.value })} className={`${input} w-fit`}>
        <option value="any">指定なし</option>
        <option value="same">対象と同じ区画</option>
        <option value="other">対象と別の区画</option>
        {areas.map((a) => (
          <option key={a} value={`area:${a}`}>
            {a}
          </option>
        ))}
      </select>
      <span className="text-xs text-zinc-500">待機時の状態</span>
      <select value={sel.normal} onChange={(e) => set({ normal: e.target.value as BlockSelector["normal"] })} className={`${input} w-fit`}>
        <option value="any">指定なし</option>
        <option value="open">普段開</option>
        <option value="close">普段閉</option>
      </select>
      <span className="text-xs text-zinc-500">名称・番号</span>
      <div className="flex flex-wrap items-center gap-2">
        <input value={sel.nameIncludes} onChange={(e) => set({ nameIncludes: e.target.value })} placeholder="名称に含む語" className={`${input} w-40`} />
        <input value={sel.codePrefix} onChange={(e) => set({ codePrefix: e.target.value })} placeholder="番号の先頭（例：CY）" className={`${input} w-40`} />
      </div>
      <span className="text-xs text-zinc-500">個数</span>
      <label className="flex items-center gap-1.5">
        対象に近い順に
        <input
          type="number"
          min={0}
          value={Number.isFinite(sel.nearest) ? sel.nearest : ""}
          onChange={(e) => set({ nearest: e.target.value === "" ? NaN : Number(e.target.value) })}
          className={`${input} w-20`}
        />
        個（0 ならすべて）
      </label>
    </div>
  );
}

export default function RuleBlockEditor({
  blocks,
  onChange,
  steps,
  g,
  areas,
  base,
  previewTarget,
  relations,
  previewCalc,
  previewFlush,
  previewFire,
}: {
  blocks: RuleBlock[];
  onChange: (b: RuleBlock[]) => void;
  /** 工程名（先頭は「作業前」） */
  steps: string[];
  g: Graph;
  areas: string[];
  base: Record<string, ValveState>;
  /** 当てはまる機器の確認に使う対象（無ければ「指定なし」の条件だけ確認する） */
  previewTarget?: string | null;
  /** 選べる「対象との関係」 */
  relations?: BlockRelation[];
  /** 計算の部品の結果（当てはまる機器の確認に使う） */
  previewCalc?: IsoParts | null;
  /** 計算の部品「循環経路」の結果（当てはまる機器の確認に使う） */
  previewFlush?: FlushParts | null;
  /** 計算の部品「消火試験の範囲」の結果（当てはまる機器の確認に使う） */
  previewFire?: FireParts | null;
}) {
  const update = (i: number, b: RuleBlock) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const opSteps = steps.slice(1);
  return (
    <div className="space-y-2">
      {blocks.length === 0 && <p className="text-sm text-zinc-400">追加のルールはありません。</p>}
      {blocks.map((b, i) => {
        const canPreview =
          b.when.relation === "any" ||
          ((b.when.relation === "targetBranch" || b.when.relation === "targetOutletBranch") && !!previewTarget) ||
          (needsCalc(b.when.relation) === "isolation" && !!previewCalc) ||
          (needsCalc(b.when.relation) === "flush" && !!previewFlush) ||
          (needsCalc(b.when.relation) === "fireTest" && !!previewFire);
        const matched = canPreview
          ? selectNodes(g, b.when, { target: previewTarget ?? null, route: null, base, calc: previewCalc ?? null, flush: previewFlush ?? null, fire: previewFire ?? null }).filter((n) =>
              ["valve", "drain", "gauge", "pump", "transferPump"].includes(n.kind)
            )
          : null;
        return (
          <div key={b.id} className={`${card} ${b.enabled ? "" : "opacity-60"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <input type="checkbox" checked={b.enabled} onChange={(e) => update(i, { ...b, enabled: e.target.checked })} title="有効" />
              <input value={b.name} onChange={(e) => update(i, { ...b, name: e.target.value })} className={`${input} flex-1 font-semibold`} />
              <IconBtn onClick={() => move(i, -1)} title="上へ">▲</IconBtn>
              <IconBtn onClick={() => move(i, 1)} title="下へ">▼</IconBtn>
              <IconBtn onClick={() => onChange([...blocks.slice(0, i + 1), { ...structuredClone(b), id: newRuleId(), name: `${b.name}（コピー）` }, ...blocks.slice(i + 1)])} title="複製">
                複製
              </IconBtn>
              <IconBtn onClick={() => onChange(blocks.filter((_, j) => j !== i))} title="削除" danger>
                削除
              </IconBtn>
            </div>
            <div className="mt-2 grid gap-3 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-semibold text-cyan-700 dark:text-cyan-400">もし（この条件の機器なら）</p>
                <SelectorFields sel={b.when} onChange={(when) => update(i, { ...b, when })} areas={areas} relationList={relations} />
                <p className="mt-1 text-xs text-zinc-500">
                  {matched
                    ? `当てはまる機器：${matched.length}件${matched.length ? `（${matched.slice(0, 6).map((n) => n.label).join("・")}${matched.length > 6 ? " ほか" : ""}）` : ""}`
                    : "当てはまる機器は、作成画面で対象・経路が決まると決まります"}
                </p>
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">なら（工程ごとの操作）</p>
                <table className="text-sm">
                  <tbody>
                    {opSteps.map((st) => (
                      <tr key={st}>
                        <td className="pr-2 text-xs text-zinc-600 dark:text-zinc-400">{st}</td>
                        <td>
                          <select
                            value={b.ops[st] ?? ""}
                            onChange={(e) => {
                              const ops = { ...b.ops };
                              if (e.target.value) ops[st] = e.target.value as "open" | "close";
                              else delete ops[st];
                              update(i, { ...b, ops });
                            }}
                            className={`${input} py-0.5`}
                          >
                            <option value="">—（操作しない）</option>
                            <option value="open">開ける（ポンプは起動）</option>
                            <option value="close">閉める（ポンプは停止）</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {Object.keys(b.ops).filter((s) => !steps.includes(s)).length > 0 && (
                  <p className="mt-1 text-xs text-red-600">
                    無い工程の操作があります：{Object.keys(b.ops).filter((s) => !steps.includes(s)).join("・")}
                    <button
                      className="ml-2 underline"
                      onClick={() => update(i, { ...b, ops: Object.fromEntries(Object.entries(b.ops).filter(([s]) => steps.includes(s))) })}
                    >
                      取り除く
                    </button>
                  </p>
                )}
                <label className="mt-2 flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={b.restore} onChange={(e) => update(i, { ...b, restore: e.target.checked })} />
                  最後の工程（{steps[steps.length - 1]}）で待機状態に戻す
                </label>
                <input
                  value={b.note}
                  onChange={(e) => update(i, { ...b, note: e.target.value })}
                  placeholder="チェックリストの注記（空ならルール名）"
                  className={`${input} mt-2 w-full`}
                />
              </div>
            </div>
          </div>
        );
      })}
      <button onClick={() => onChange([...blocks, newBlock()])} className="rounded-lg border border-dashed border-zinc-400 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900">
        ＋ ルールを追加
      </button>
    </div>
  );
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-xs ${
        on ? "border-cyan-600 bg-cyan-600 text-white" : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      }`}
    >
      {children}
    </button>
  );
}

export function IconBtn({ onClick, title, danger, children }: { onClick: () => void; title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded border px-2 py-0.5 text-xs ${
        danger ? "border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400" : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      }`}
    >
      {children}
    </button>
  );
}
