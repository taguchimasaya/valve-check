"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import FacilitySwitcher from "@/components/piping/FacilitySwitcher";
import { useDiagramInfo, useGraph, usePipingStore } from "@/lib/piping/usePiping";
import {
  DEFAULT_FIRE_TEST_RULES,
  fireTestRulesOf,
  fireTestSteps,
  validateFireTestRules,
  type FireTestRules,
} from "@/lib/piping/rules";
import { fireTestTanks } from "@/lib/piping/fireTest";

// ⑤ チェックリスト作成のルール：拠点ごとに、チェックリストを自動で作るときの決まりを登録する。

export default function RulesPage() {
  const g = useGraph();
  const diagramInfo = useDiagramInfo();
  const { store, act } = usePipingStore(0);
  const saved = store ? fireTestRulesOf(store.rules) : null;
  // 編集中の値（未編集なら保存済みの値を表示）
  const [draft, setDraft] = useState<FireTestRules | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const r = draft ?? saved;
  const hasFire = fireTestTanks(g).length > 0;

  if (!r || !saved) {
    return (
      <Shell>
        <p className="text-sm text-zinc-500">読み込み中…</p>
      </Shell>
    );
  }
  const errors = validateFireTestRules(r);
  const dirty = JSON.stringify(r) !== JSON.stringify(saved);
  const update = (patch: Partial<FireTestRules>) => {
    setMessage(null);
    setDraft({ ...r, ...patch });
  };

  async function save() {
    if (errors.length) return;
    setSaving(true);
    try {
      await act({ action: "setRules", rules: { ...(store?.rules ?? {}), fireTest: r! } });
      setDraft(null);
      setMessage({ type: "ok", text: "ルールを登録しました。これから作るチェックリストに使われます（保存済みのチェックリストは作り直すと反映されます）。" });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        ① チェックリスト作成で、弁・ポンプの操作を自動で作るときの決まりです。拠点ごとに登録します（今の拠点：{g.facility.name}）。
      </p>
      {store?.rules?.updatedAt && (
        <p className="mt-1 text-xs text-zinc-500">最終更新：{new Date(store.rules.updatedAt).toLocaleString("ja-JP")}</p>
      )}

      <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">消火設備機能試験</h2>
          {!hasFire && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              この拠点の系統図には冷却散水・発泡装置の付いたタンクがないため、作成画面には表示されません
            </span>
          )}
        </div>

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
          <Field
            label="冷却散水のシリンダー弁を開ける工程"
            help="「シリンダー弁開」にすると、ポンプ起動と同時に冷却散水から放水が始まります。"
          >
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
                <Check
                  key={k}
                  label={l}
                  checked={r.adjacency[k]}
                  onChange={(c) => update({ adjacency: { ...r.adjacency, [k]: c } })}
                />
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
              <NumberBox label="水" value={r.waterHydrants} onChange={(v) => update({ waterHydrants: v })} />
              <NumberBox label="泡" value={r.foamHydrants} onChange={(v) => update({ foamHydrants: v })} />
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
          <Field label="試験範囲外へ分岐する弁（普段開のもの）">
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
            <Check
              label="仕切りの対象にしない（予備ポンプなどの待機状態を保つ）"
              checked={r.keepPumpArea}
              onChange={(c) => update({ keepPumpArea: c })}
            />
          </Field>
        </Group>

        <Group title="機器の見分け方（系統図データの名称・番号）">
          <Field label="シリンダー弁" help="名称に含む語、または弁番号の先頭。カンマ区切りで複数指定できます。">
            <TextBox value={r.cylinderKeywords} onChange={(v) => update({ cylinderKeywords: v })} />
          </Field>
          <Field label="主消火ポンプ" help="名称にこの語を含むポンプを優先して使います（無ければ予備・補助以外のポンプ）。">
            <TextBox value={r.mainPumpKeyword} onChange={(v) => update({ mainPumpKeyword: v })} />
          </Field>
          <p className="text-xs text-zinc-500">
            タンクの冷却散水・発泡装置は、名称がタンク番号で始まるもの（例：「T-401 冷却散水設備（上側）」）をそのタンクの設備とみなします。
          </p>
        </Group>

        {errors.length > 0 && (
          <ul className="mt-3 space-y-1">
            {errors.map((e) => (
              <li key={e} className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                {e}
              </li>
            ))}
          </ul>
        )}
        {message && (
          <p
            className={`mt-3 rounded px-2 py-1 text-sm ${
              message.type === "ok"
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
            }`}
          >
            {message.text}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={save}
            disabled={!dirty || errors.length > 0 || saving}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            {saving ? "登録中…" : "ルールを登録"}
          </button>
          <button
            onClick={() => {
              setDraft(null);
              setMessage(null);
            }}
            disabled={!dirty}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
          >
            変更を取り消す
          </button>
          <button
            onClick={() => update(structuredClone(DEFAULT_FIRE_TEST_RULES))}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
          >
            既定値に戻す
          </button>
          <Link href="/piping/planner" className="ml-auto self-center text-sm text-sky-700 hover:underline dark:text-sky-400">
            → ① チェックリスト作成へ
          </Link>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">ほかの作業のルール</h2>
        <p className="mt-1">
          燃料抜取（遮断範囲・ドレン口まで広げる等）・燃料末端部作業・タンク縁切りは、今は作成画面での選択とプログラムの決まりで作っています。登録できる項目は順次追加します。
        </p>
        <p className="mt-1 text-xs text-zinc-500">系統図データ：{diagramInfo.source === "db" ? `${diagramInfo.facilityId} 第${diagramInfo.versionNo}版` : "プログラム内の仮想施設"}</p>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
      <div className="mx-auto max-w-4xl">
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

function Radio<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-lg border px-2.5 py-1 text-sm ${
            value === v
              ? "border-cyan-600 bg-cyan-600 font-semibold text-white"
              : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function NumberBox({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5">
      {label}
      <input
        type="number"
        min={0}
        max={30}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
        className="w-20 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
      />
      口
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
