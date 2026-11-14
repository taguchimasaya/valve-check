"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import FacilitySwitcher from "@/components/piping/FacilitySwitcher";
import RuleBlockEditor, { IconBtn, SelectorFields, useAreas } from "@/components/piping/RuleBlockEditor";
import { normalValveState, type Graph } from "@/lib/piping/graph";
import { useGraph, usePipingStore } from "@/lib/piping/usePiping";
import { PLAN_STEPS, rowGlyph, ROLE_LABEL } from "@/lib/piping/checklist";
import { FLUSH_STEPS, ISOLATION_STEPS } from "@/lib/piping/workTypes";
import { fireTestTanks } from "@/lib/piping/fireTest";
import { buildCustomChecklist } from "@/lib/piping/ruleBlocks";
import {
  blockMethodOf,
  customStepsOf,
  DEFAULT_BLOCK_METHOD,
  DEFAULT_DRAIN_RULES,
  DEFAULT_FIRE_TEST_RULES,
  DEFAULT_FLUSH_RULES,
  DEFAULT_ISOLATION_RULES,
  drainRulesOf,
  fireTestRulesOf,
  fireTestSteps,
  flushRulesOf,
  isolationRulesOf,
  newCustomType,
  newRuleId,
  validateBlocks,
  validateCustomType,
  validateDrainRules,
  validateFireTestRules,
  validateFlushRules,
  type BlockMethod,
  type BuiltinWorkType,
  type ChecklistRules,
  type CustomWorkType,
  type DrainRules,
  type FireTestRules,
  type FlushRules,
  type IsolationRules,
  type RuleBlock,
} from "@/lib/piping/rules";

// ⑤ チェックリスト作成のルール：拠点ごとに、チェックリストを自動で作るときの決まりを登録する。
//  ・拠点共通の仕切り方（1ブロック／2ブロック）
//  ・既存の作業（燃料抜取・末端部作業・タンク縁切り・消火設備機能試験）の設定値と、追加ルール（ブロック）
//  ・ユーザー定義の作業（工程とルールブロックを組み立てて、新しい作業種別を作る）

type Draft = {
  blockMethod: BlockMethod;
  fireTest: FireTestRules;
  drain: DrainRules;
  flush: FlushRules;
  tankIsolation: IsolationRules;
  blocks: Record<BuiltinWorkType, RuleBlock[]>;
  customTypes: CustomWorkType[];
};

function draftOf(r: ChecklistRules | undefined): Draft {
  return {
    blockMethod: blockMethodOf(r),
    fireTest: fireTestRulesOf(r),
    drain: drainRulesOf(r),
    flush: flushRulesOf(r),
    tankIsolation: isolationRulesOf(r),
    blocks: {
      drain: r?.blocks?.drain ?? [],
      flush: r?.blocks?.flush ?? [],
      tankIsolation: r?.blocks?.tankIsolation ?? [],
      fireTest: r?.blocks?.fireTest ?? [],
    },
    customTypes: r?.customTypes ?? [],
  };
}

type Tab = "common" | BuiltinWorkType | "custom";
const TABS: [Tab, string][] = [
  ["common", "共通（仕切り方）"],
  ["drain", "燃料抜取"],
  ["flush", "燃料末端部作業"],
  ["tankIsolation", "タンク縁切り"],
  ["fireTest", "消火設備機能試験"],
  ["custom", "ユーザー定義の作業"],
];

export default function RulesPage() {
  const g = useGraph();
  const areas = useAreas(g);
  const base = useMemo(() => normalValveState(g.facility), [g]);
  const { store, act } = usePipingStore(0);
  const saved = useMemo(() => (store ? draftOf(store.rules) : null), [store]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<Tab>("common");
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const d = draft ?? saved;

  if (!d || !saved) {
    return (
      <Shell>
        <p className="mt-2 text-sm text-zinc-500">読み込み中…</p>
      </Shell>
    );
  }
  const stepsOf: Record<BuiltinWorkType, string[]> = {
    drain: PLAN_STEPS,
    flush: FLUSH_STEPS,
    tankIsolation: ISOLATION_STEPS,
    fireTest: fireTestSteps(d.fireTest),
  };
  const errorsOf: Record<Tab, string[]> = {
    common: [],
    drain: [...validateDrainRules(d.drain), ...validateBlocks(d.blocks.drain, stepsOf.drain)],
    flush: [...validateFlushRules(d.flush), ...validateBlocks(d.blocks.flush, stepsOf.flush)],
    tankIsolation: validateBlocks(d.blocks.tankIsolation, stepsOf.tankIsolation),
    fireTest: [...validateFireTestRules(d.fireTest), ...validateBlocks(d.blocks.fireTest, stepsOf.fireTest)],
    custom: d.customTypes.flatMap((t) => validateCustomType(t).map((e) => `「${t.name || "名前なし"}」：${e}`)),
  };
  const errors = Object.values(errorsOf).flat();
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const update = (patch: Partial<Draft>) => {
    setMessage(null);
    setDraft({ ...d, ...patch });
  };
  const setBlocks = (t: BuiltinWorkType, b: RuleBlock[]) => update({ blocks: { ...d.blocks, [t]: b } });

  async function save() {
    if (errors.length || !d) return;
    setSaving(true);
    try {
      await act({
        action: "setRules",
        rules: {
          blockMethod: d.blockMethod,
          fireTest: d.fireTest,
          drain: d.drain,
          flush: d.flush,
          tankIsolation: d.tankIsolation,
          blocks: d.blocks,
          customTypes: d.customTypes,
        },
      });
      setDraft(null);
      setMessage({ type: "ok", text: "ルールを登録しました。これから作るチェックリストに使われます（保存済みのチェックリストは作り直すと反映されます）。" });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  const blocksSection = (t: BuiltinWorkType) => (
    <Group title="追加ルール（もし〜なら、〜する）">
      <p className="text-xs text-zinc-500">
        プログラムが作るチェックリストに、条件に合う弁・ポンプの操作を追加・上書きします。工程：{stepsOf[t].slice(1).join(" → ")}
      </p>
      <RuleBlockEditor blocks={d.blocks[t]} onChange={(b) => setBlocks(t, b)} steps={stepsOf[t]} g={g} areas={areas} base={base} />
    </Group>
  );

  return (
    <Shell>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        ① チェックリスト作成で、弁・ポンプの操作を自動で作るときの決まりです。拠点ごとに登録します（今の拠点：{g.facility.name}）。
      </p>
      {store?.rules?.updatedAt && <p className="mt-1 text-xs text-zinc-500">最終更新：{new Date(store.rules.updatedAt).toLocaleString("ja-JP")}</p>}

      <div className="sticky top-0 z-10 -mx-4 mt-3 border-b border-zinc-200 bg-zinc-50/95 px-4 py-2 backdrop-blur dark:border-zinc-800 dark:bg-black/90">
        <div className="flex flex-wrap gap-1">
          {TABS.map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                tab === k ? "bg-zinc-900 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              {l}
              {errorsOf[k].length > 0 && <span className="ml-1 text-red-500">●</span>}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={!dirty || errors.length > 0 || saving}
            className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            {saving ? "登録中…" : "ルールを登録"}
          </button>
          <button
            onClick={() => {
              setDraft(null);
              setMessage(null);
            }}
            disabled={!dirty}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
          >
            変更を取り消す
          </button>
          {dirty && <span className="text-xs text-amber-700 dark:text-amber-400">未登録の変更があります</span>}
          {errors.length > 0 && <span className="text-xs text-red-600">入力に問題があります（● のタブ）</span>}
          <Link href="/piping/planner" className="ml-auto text-sm text-sky-700 hover:underline dark:text-sky-400">
            → ① チェックリスト作成へ
          </Link>
        </div>
        {message && (
          <p
            className={`mt-2 rounded px-2 py-1 text-sm ${
              message.type === "ok" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
            }`}
          >
            {message.text}
          </p>
        )}
      </div>

      <section className="mt-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <Errors list={errorsOf[tab]} />
        {tab === "common" && (
          <>
            <Head title="仕切り方（拠点共通）" onReset={() => update({ blockMethod: { ...DEFAULT_BLOCK_METHOD } })} />
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              作業範囲・経路と、運用中の系統を何個の弁で仕切るかの決まりです。燃料抜取の遮断弁、末端部作業・タンク縁切りの分岐先の弁、消火設備機能試験の試験範囲外との仕切りに使います。
            </p>
            <Group title="仕切る弁の数">
              <Field
                label="ブロック数"
                help="2ブロック（ダブルブロック）：1つ目の弁の外側の区間を囲む弁も閉め、弁2つで仕切ります。外側がタンク・施設外に直接つながる所は1ブロックのまま、作成画面に注意を出します。"
              >
                <Radio
                  value={String(d.blockMethod.blocks)}
                  onChange={(v) => update({ blockMethod: { ...d.blockMethod, blocks: Number(v) as 1 | 2 } })}
                  options={[
                    ["1", "1ブロック（弁1つで仕切る）"],
                    ["2", "2ブロック（ダブルブロック）"],
                  ]}
                />
              </Field>
              <Field label="ブリード" help="2つの弁の間の区間のドレン口を開けて残液を抜き、1つ目の弁の漏れがないかを確認します（ダブルブロック＆ブリード）。">
                <Check
                  label="2ブロックの間のドレン口を開ける"
                  checked={d.blockMethod.bleed}
                  disabled={d.blockMethod.blocks !== 2}
                  onChange={(c) => update({ blockMethod: { ...d.blockMethod, bleed: c } })}
                />
              </Field>
            </Group>
            <p className="mt-3 text-xs text-zinc-500">
              追加ルール・ユーザー定義の作業では、条件「対象につながる最初の弁」「経路から分岐する先の最初の弁」ごとに 1ブロック／2ブロック を選べます。
            </p>
          </>
        )}

        {tab === "drain" && (
          <>
            <Head title="燃料抜取（機器点検・交換等）" onReset={() => update({ drain: structuredClone(DEFAULT_DRAIN_RULES) })} />
            <Group title="遮断範囲・弁の操作">
              <Field label="ドレン口まで広げる（初期値）" help="作成画面のチェックの初期値です。">
                <Check label="対象区間にドレン口が無ければ、ドレン口のある区間まで遮断範囲を広げる" checked={d.drain.expandToDrain} onChange={(c) => update({ drain: { ...d.drain, expandToDrain: c } })} />
              </Field>
              <Field label="範囲内の弁">
                <Radio
                  value={d.drain.openInternal ? "open" : "keep"}
                  onChange={(v) => update({ drain: { ...d.drain, openInternal: v === "open" } })}
                  options={[
                    ["open", "普段閉のものはラインナップで開ける"],
                    ["keep", "開けない（閉を確認）"],
                  ]}
                />
              </Field>
              <Field label="充填ラインが無いとき">
                <Radio
                  value={d.drain.crackFillWithoutLine ? "crack" : "none"}
                  onChange={(v) => update({ drain: { ...d.drain, crackFillWithoutLine: v === "crack" } })}
                  options={[
                    ["crack", "遮断弁を微開して充填する"],
                    ["none", "充填工程で弁を操作しない"],
                  ]}
                />
              </Field>
            </Group>
            <Group title="時間の試算">
              <Field label="可搬ポンプ・充填の流量（初期値）">
                <div className="flex flex-wrap gap-4 text-sm">
                  <NumberBox label="可搬ポンプ" unit="L/min" value={d.drain.portableLpm} onChange={(v) => update({ drain: { ...d.drain, portableLpm: v } })} />
                  <NumberBox label="充填" unit="L/min" value={d.drain.fillLpm} onChange={(v) => update({ drain: { ...d.drain, fillLpm: v } })} />
                </div>
              </Field>
              <Field label="自然流下の能力（口径別）">
                <div className="flex flex-wrap gap-4 text-sm">
                  {(["25", "40", "50", "80"] as const).map((k) => (
                    <NumberBox
                      key={k}
                      label={`${k}A`}
                      unit="L/min"
                      value={d.drain.gravityLpm[k]}
                      onChange={(v) => update({ drain: { ...d.drain, gravityLpm: { ...d.drain.gravityLpm, [k]: v } } })}
                    />
                  ))}
                </div>
              </Field>
            </Group>
            {blocksSection("drain")}
          </>
        )}

        {tab === "flush" && (
          <>
            <Head title="燃料末端部作業（循環）" onReset={() => update({ flush: { ...DEFAULT_FLUSH_RULES } })} />
            <Group title="循環">
              <Field label="循環量の目安" help="末端部の配管容量の何倍を流すか">
                <NumberBox label="" unit="倍" step={0.5} value={d.flush.turnover} onChange={(v) => update({ flush: { ...d.flush, turnover: v } })} />
              </Field>
              <Field label="時間の試算に使うポンプ能力">
                <div className="flex flex-wrap gap-4 text-sm">
                  <NumberBox label="払出ポンプ" unit="L/min" value={d.flush.pumpLpm} onChange={(v) => update({ flush: { ...d.flush, pumpLpm: v } })} />
                  <NumberBox label="移送ポンプ" unit="L/min" value={d.flush.transferPumpLpm} onChange={(v) => update({ flush: { ...d.flush, transferPumpLpm: v } })} />
                </div>
              </Field>
              <Field label="経路から分岐する先の弁">
                <Radio
                  value={d.flush.closeSide ? "close" : "keep"}
                  onChange={(v) => update({ flush: { ...d.flush, closeSide: v === "close" } })}
                  options={[
                    ["close", "閉める（燃料の回り込み防止）"],
                    ["keep", "操作しない"],
                  ]}
                />
              </Field>
            </Group>
            {blocksSection("flush")}
          </>
        )}

        {tab === "tankIsolation" && (
          <>
            <Head title="タンク縁切り作業" onReset={() => update({ tankIsolation: { ...DEFAULT_ISOLATION_RULES } })} />
            <Group title="移送・縁切り">
              <Field label="経路から分岐する先の弁">
                <Radio
                  value={d.tankIsolation.closeSide ? "close" : "keep"}
                  onChange={(v) => update({ tankIsolation: { ...d.tankIsolation, closeSide: v === "close" } })}
                  options={[
                    ["close", "閉める（燃料の回り込み防止）"],
                    ["keep", "操作しない"],
                  ]}
                />
              </Field>
              <Field label="仕切板">
                <Check label="縁切りの工程に「必要に応じて仕切板を挿入」の注記を入れる" checked={d.tankIsolation.blindNote} onChange={(c) => update({ tankIsolation: { ...d.tankIsolation, blindNote: c } })} />
              </Field>
            </Group>
            {blocksSection("tankIsolation")}
          </>
        )}

        {tab === "fireTest" && (
          <>
            <Head title="消火設備機能試験" onReset={() => update({ fireTest: structuredClone(DEFAULT_FIRE_TEST_RULES) })} />
            {fireTestTanks(g).length === 0 && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">この拠点の系統図には冷却散水・発泡装置の付いたタンクがないため、作成画面には表示されません。</p>
            )}
            <FireTestForm r={d.fireTest} onChange={(fireTest) => update({ fireTest })} />
            {blocksSection("fireTest")}
          </>
        )}

        {tab === "custom" && (
          <CustomTypes g={g} areas={areas} base={base} list={d.customTypes} onChange={(customTypes) => update({ customTypes })} />
        )}
      </section>
    </Shell>
  );
}

// ───────────── 消火設備機能試験の設定 ─────────────

function FireTestForm({ r, onChange }: { r: FireTestRules; onChange: (r: FireTestRules) => void }) {
  const update = (p: Partial<FireTestRules>) => onChange({ ...r, ...p });
  return (
    <>
      <Group title="工程">
        <Field label="試験の順番" help={`工程：${fireTestSteps(r).slice(1).join(" → ")}`}>
          <Radio
            value={r.order}
            onChange={(v) => update({ order: v })}
            options={[
              ["foamFirst", "泡系統 → 水系統"],
              ["waterFirst", "水系統 → 泡系統"],
            ]}
          />
        </Field>
        <Field label="冷却散水のシリンダー弁を開ける工程" help="「シリンダー弁開」にすると、ポンプ起動と同時に冷却散水から放水が始まります。">
          <Radio
            value={r.sprinklerOpenAt}
            onChange={(v) => update({ sprinklerOpenAt: v })}
            options={[
              ["cylinderStep", "シリンダー弁開（制御室）の工程"],
              ["waterStep", "水系統試験の工程"],
            ]}
          />
        </Field>
      </Group>
      <Group title="使う設備">
        <Field label="試験タンクの冷却散水">
          <Radio
            value={r.testTankSprinkle ? "on" : "off"}
            onChange={(v) => update({ testTankSprinkle: v === "on" })}
            options={[
              ["off", "散水しない（シリンダー弁の閉を確認）"],
              ["on", "散水する"],
            ]}
          />
        </Field>
        <Field label="隣接タンクとみなす並び" help="同じヤード（区画）のタンクのうち、選んだ向きで最も近いタンクです。">
          <div className="flex flex-wrap gap-3">
            {(
              [
                ["horizontal", "左右"],
                ["vertical", "上下"],
                ["diagonal", "斜め"],
              ] as const
            ).map(([k, l]) => (
              <Check key={k} label={l} checked={r.adjacency[k]} onChange={(c) => update({ adjacency: { ...r.adjacency, [k]: c } })} />
            ))}
          </div>
        </Field>
        <Field label="隣接タンクで使う冷却散水">
          <Radio
            value={r.adjacentLines}
            onChange={(v) => update({ adjacentLines: v })}
            options={[
              ["facing", "試験タンクに向いた側だけ"],
              ["all", "すべての系統"],
              ["none", "使わない"],
            ]}
          />
        </Field>
        <Field label="使う消火栓の口数">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <NumberBox label="水" unit="口" value={r.waterHydrants} onChange={(v) => update({ waterHydrants: v })} />
            <NumberBox label="泡" unit="口" value={r.foamHydrants} onChange={(v) => update({ foamHydrants: v })} />
          </div>
        </Field>
        <Field label="消火栓の選び方">
          <Radio
            value={r.hydrantSameAreaFirst ? "area" : "near"}
            onChange={(v) => update({ hydrantSameAreaFirst: v === "area" })}
            options={[
              ["area", "同じヤードを優先し、試験タンクに近い順"],
              ["near", "区画を問わず、試験タンクに近い順"],
            ]}
          />
        </Field>
      </Group>
      <Group title="仕切り・誤放出防止">
        <Field label="同じヤードのほかのタンクの発泡装置">
          <Radio
            value={r.closeOtherFoam ? "close" : "check"}
            onChange={(v) => update({ closeOtherFoam: v === "close" })}
            options={[
              ["close", "シリンダー弁の閉を確認し、手動弁を閉める（復旧で開）"],
              ["check", "シリンダー弁の閉を確認するだけ"],
            ]}
          />
        </Field>
        <Field label="試験範囲外へ分岐する弁（普段開のもの）" help="仕切る弁の数（1ブロック／2ブロック）は「共通」タブで設定します。">
          <Radio
            value={r.isolateOutside ? "close" : "keep"}
            onChange={(v) => update({ isolateOutside: v === "close" })}
            options={[
              ["close", "閉めて仕切る（復旧で開）"],
              ["keep", "操作しない"],
            ]}
          />
        </Field>
        <Field label="消火ポンプ室の弁">
          <Check label="仕切りの対象にしない（予備ポンプなどの待機状態を保つ）" checked={r.keepPumpArea} onChange={(c) => update({ keepPumpArea: c })} />
        </Field>
      </Group>
      <Group title="機器の見分け方（系統図データの名称・番号）">
        <Field label="シリンダー弁" help="名称に含む語、または弁番号の先頭。カンマ区切りで複数指定できます。">
          <TextBox value={r.cylinderKeywords} onChange={(v) => update({ cylinderKeywords: v })} />
        </Field>
        <Field label="主消火ポンプ" help="名称にこの語を含むポンプを優先して使います（無ければ予備・補助以外のポンプ）。">
          <TextBox value={r.mainPumpKeyword} onChange={(v) => update({ mainPumpKeyword: v })} />
        </Field>
      </Group>
    </>
  );
}

// ───────────── ユーザー定義の作業 ─────────────

const TARGET_KINDS = ["strainer", "filter", "pump", "transferPump", "valve", "check", "tank"];

function CustomTypes({
  g,
  areas,
  base,
  list,
  onChange,
}: {
  g: Graph;
  areas: string[];
  base: Record<string, "open" | "close">;
  list: CustomWorkType[];
  onChange: (l: CustomWorkType[]) => void;
}) {
  const [selId, setSelId] = useState<string | null>(null);
  const sel = list.find((t) => t.id === selId) ?? list[0] ?? null;
  const update = (t: CustomWorkType) => onChange(list.map((x) => (x.id === t.id ? t : x)));
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">作業の一覧</p>
        {list.length === 0 && <p className="text-sm text-zinc-400">まだありません。</p>}
        {list.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelId(t.id)}
            className={`block w-full truncate rounded-lg px-3 py-1.5 text-left text-sm ${
              sel?.id === t.id ? "bg-cyan-600 font-semibold text-white" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
            }`}
          >
            {t.name || "（名前なし）"}
          </button>
        ))}
        <button
          onClick={() => {
            const t = newCustomType();
            onChange([...list, t]);
            setSelId(t.id);
          }}
          className="mt-2 w-full rounded-lg border border-dashed border-zinc-400 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
        >
          ＋ 新しい作業を作る
        </button>
        <p className="pt-2 text-xs text-zinc-500">作った作業は ① チェックリスト作成の「作業内容」に表示されます（登録後）。</p>
      </div>
      {sel ? (
        <CustomEditor
          key={sel.id}
          g={g}
          areas={areas}
          base={base}
          t={sel}
          onChange={update}
          onCopy={() => {
            const c = { ...structuredClone(sel), id: newRuleId(), name: `${sel.name}（コピー）` };
            onChange([...list, c]);
            setSelId(c.id);
          }}
          onDelete={() => {
            if (!confirm(`「${sel.name}」を削除しますか？（登録すると元に戻せません。作成済みのチェックリストはそのまま使えます）`)) return;
            onChange(list.filter((x) => x.id !== sel.id));
            setSelId(null);
          }}
        />
      ) : (
        <p className="text-sm text-zinc-500">「＋ 新しい作業を作る」から、工程とルールを組み立てて作業種別を作れます。</p>
      )}
    </div>
  );
}

function CustomEditor({
  g,
  areas,
  base,
  t,
  onChange,
  onCopy,
  onDelete,
}: {
  g: Graph;
  areas: string[];
  base: Record<string, "open" | "close">;
  t: CustomWorkType;
  onChange: (t: CustomWorkType) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const steps = customStepsOf(t);
  const [previewTarget, setPreviewTarget] = useState<string>("");
  const candidates = useMemo(
    () =>
      t.target === "none"
        ? []
        : g.facility.nodes
            .filter((n) => (t.target === "tank" ? n.kind === "tank" : TARGET_KINDS.includes(n.kind)))
            .sort((a, b) => a.label.localeCompare(b.label, "ja")),
    [g, t.target]
  );
  const target = t.target === "none" ? null : candidates.some((n) => n.id === previewTarget) ? previewTarget : null;
  const result = useMemo(() => buildCustomChecklist(g, t, target, base), [g, t, target, base]);
  const input = "rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700";

  // 工程名を変えたら、ルールの操作・経路の表示も付け替える
  const renameStep = (i: number, name: string) => {
    const old = t.steps[i].name;
    const re = (ops: Record<string, "open" | "close">) =>
      Object.fromEntries(Object.entries(ops).map(([k, v]) => [k === old ? name : k, v])) as Record<string, "open" | "close">;
    onChange({
      ...t,
      steps: t.steps.map((s, j) => (j === i ? { ...s, name } : s)),
      blocks: t.blocks.map((b) => ({ ...b, ops: re(b.ops) })),
      route: { ...t.route, showAt: t.route.showAt.map((s) => (s === old ? name : s)) },
    });
  };
  const moveStep = (i: number, dir: number) => {
    const j = i + dir;
    if (j < 0 || j >= t.steps.length) return;
    const next = [...t.steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...t, steps: next });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input value={t.name} onChange={(e) => onChange({ ...t, name: e.target.value })} placeholder="作業の名前" className={`${input} flex-1 text-base font-semibold`} />
        <IconBtn onClick={onCopy} title="複製">
          複製
        </IconBtn>
        <IconBtn onClick={onDelete} title="削除" danger>
          削除
        </IconBtn>
      </div>
      <input value={t.desc} onChange={(e) => onChange({ ...t, desc: e.target.value })} placeholder="説明（作成画面に表示）" className={`${input} w-full`} />

      <Group title="① 対象の選び方">
        <Radio
          value={t.target}
          onChange={(v) => onChange({ ...t, target: v })}
          options={[
            ["tank", "タンクを選ぶ"],
            ["equipment", "機器（ポンプ・弁・ストレーナーなど）を選ぶ"],
            ["none", "選ばない"],
          ]}
        />
      </Group>

      <Group title="② 工程（「作業前」は自動で先頭に入ります）">
        <div className="space-y-1.5">
          {t.steps.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-right text-xs text-zinc-500">{i + 1}</span>
              <input value={s.name} onChange={(e) => renameStep(i, e.target.value)} className={`${input} w-44`} placeholder="工程名" />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={s.manual} onChange={(e) => onChange({ ...t, steps: t.steps.map((x, j) => (j === i ? { ...x, manual: e.target.checked } : x)) })} />
                「完了」ボタンで終える
              </label>
              <input
                value={s.note}
                onChange={(e) => onChange({ ...t, steps: t.steps.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)) })}
                className={`${input} min-w-48 flex-1`}
                placeholder="工程の説明（チェックリスト・現場に表示）"
              />
              <IconBtn onClick={() => moveStep(i, -1)} title="上へ">▲</IconBtn>
              <IconBtn onClick={() => moveStep(i, 1)} title="下へ">▼</IconBtn>
              <IconBtn onClick={() => onChange({ ...t, steps: t.steps.filter((_, j) => j !== i) })} title="削除" danger>
                削除
              </IconBtn>
            </div>
          ))}
          <button
            onClick={() => onChange({ ...t, steps: [...t.steps, { name: `工程${t.steps.length + 1}`, manual: false, note: "" }] })}
            className="rounded-lg border border-dashed border-zinc-400 px-3 py-1 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            ＋ 工程を追加
          </button>
        </div>
      </Group>

      <Group title="③ 作業の経路（任意）">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={t.route.enabled} onChange={(e) => onChange({ ...t, route: { ...t.route, enabled: e.target.checked } })} />
          経路を使う（条件に合う機器のうち、対象に届く最も近いものから対象まで）
        </label>
        {t.route.enabled && (
          <div className="mt-2 space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
            <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">経路の起点の条件</p>
            <SelectorFields
              sel={t.route.from}
              onChange={(from) => onChange({ ...t, route: { ...t.route, from } })}
              areas={areas}
              relations={false}
              rowKinds={["pump", "transferPump", "valve", "tank", "source"]}
            />
            <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">流れを図面に表示する工程</p>
            <div className="flex flex-wrap gap-3">
              {steps.slice(1).map((s) => (
                <Check
                  key={s}
                  label={s}
                  checked={t.route.showAt.includes(s)}
                  onChange={(c) => onChange({ ...t, route: { ...t.route, showAt: c ? [...t.route.showAt, s] : t.route.showAt.filter((x) => x !== s) } })}
                />
              ))}
            </div>
            <p className="text-xs text-zinc-500">ルールの条件「作業の範囲・経路の上」「経路から分岐する先の最初の弁」は、この経路を使います。</p>
          </div>
        )}
      </Group>

      <Group title="④ ルール（もし〜なら、〜する）">
        <RuleBlockEditor blocks={t.blocks} onChange={(blocks) => onChange({ ...t, blocks })} steps={steps} g={g} areas={areas} base={base} previewTarget={target} />
      </Group>

      <Group title="⑤ 試しに作ってみる">
        {t.target !== "none" && (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            対象
            <select value={target ?? ""} onChange={(e) => setPreviewTarget(e.target.value)} className={input}>
              <option value="">（選んでください）</option>
              {candidates.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}　{n.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {result.error ? (
          <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">{result.error}</p>
        ) : (
          <div className="mt-2 max-h-96 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-2 py-1 text-left font-normal">機器</th>
                  <th className="text-left font-normal">区分</th>
                  {steps.map((s) => (
                    <th key={s} className="px-1 text-center font-normal">
                      {s}
                    </th>
                  ))}
                  <th className="text-left font-normal">注記</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.code} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-2 py-0.5" title={r.name}>
                      {r.code}
                    </td>
                    <td className="text-zinc-500">{ROLE_LABEL[r.role]}</td>
                    {r.states.map((s, i) => (
                      <td key={i} className="text-center">
                        {rowGlyph(r, s, i)}
                      </td>
                    ))}
                    <td className="text-zinc-500">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.warnings.length > 0 && (
          <ul className="mt-2 space-y-1">
            {result.warnings.map((w) => (
              <li key={w} className="text-xs text-amber-700 dark:text-amber-400">
                ・{w}
              </li>
            ))}
          </ul>
        )}
      </Group>
    </div>
  );
}

// ───────────── 部品 ─────────────

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
      <div className="mx-auto max-w-6xl">
        <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← 配管系統図メニュー
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">⑤ チェックリスト作成のルール</h1>
          <FacilitySwitcher />
        </div>
        {children}
      </div>
    </main>
  );
}

function Head({ title, onReset }: { title: string; onReset: () => void }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
      <button onClick={onReset} className="text-xs text-zinc-500 underline hover:text-zinc-700">
        設定値を既定に戻す
      </button>
    </div>
  );
}

function Errors({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <ul className="mb-3 space-y-1">
      {list.map((e) => (
        <li key={e} className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {e}
        </li>
      ))}
    </ul>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <h3 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[220px_1fr] sm:gap-3">
      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</p>
      <div>
        {children}
        {help && <p className="mt-1 text-xs text-zinc-500">{help}</p>}
      </div>
    </div>
  );
}

function Radio<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-lg border px-2.5 py-1 text-sm ${
            value === v ? "border-cyan-600 bg-cyan-600 font-semibold text-white" : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (c: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-sm ${disabled ? "opacity-50" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function NumberBox({ label, unit, value, onChange, step }: { label: string; unit: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="inline-flex items-center gap-1.5">
      {label}
      <input
        type="number"
        min={0}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
        className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
      />
      {unit}
    </label>
  );
}

function TextBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full max-w-sm rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
    />
  );
}
