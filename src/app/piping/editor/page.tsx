"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import PipingDiagram, { type NodeMark } from "@/components/piping/PipingDiagram";
import { getFacility } from "@/lib/piping/facility";
import { buildGraph, normalValveState } from "@/lib/piping/graph";
import { applyLayout, EMPTY_LAYOUT, type PipingLayout, type UnderlaySetting } from "@/lib/piping/layout";
import {
  imageFileToUnderlay,
  loadUnderlayImage,
  pdfToImage,
  saveUnderlayImage,
  type UnderlayImage,
} from "@/lib/piping/underlay";
import { usePipingStore } from "@/lib/piping/usePiping";
import type { NodeKind } from "@/lib/piping/types";

// 図面の下絵を見ながら、系統図の機器を図面どおりの位置に配置する画面。
// 系統（つながり・諸元）は変えず、位置だけを保存する。

const KIND_LABEL: Record<NodeKind, string> = {
  junction: "分岐点",
  valve: "仕切弁",
  check: "逆止弁",
  tank: "タンク",
  pump: "払出ポンプ",
  transferPump: "ポンプ",
  strainer: "ストレーナー",
  filter: "フィルター",
  psv: "安全弁",
  drain: "ドレン口",
  gauge: "圧力計取付口",
  source: "受入口",
  sink: "払出先",
};

const SAMPLE_PDF = "/drawings/virtual-airport-piping.pdf";
const SAMPLE_ALIGN = "/drawings/virtual-airport-piping.json";

function normalize(t: string) {
  return t.normalize("NFKC").toLowerCase();
}

export default function UnderlayEditorPage() {
  const { store, act, error } = usePipingStore(0);
  const facility = useMemo(() => getFacility(), []);

  // 編集中の配置（保存するまでは共有データに反映しない）
  const [draft, setDraft] = useState<PipingLayout | null>(null);
  const layout = draft ?? store?.layout ?? EMPTY_LAYOUT;
  const dirty = draft !== null;
  const edit = (fn: (l: PipingLayout) => PipingLayout) => setDraft(fn(structuredClone(layout)));

  const graph = useMemo(() => buildGraph(applyLayout(facility, layout)), [facility, layout]);
  const valveState = useMemo(() => normalValveState(facility), [facility]);
  const unplaced = useMemo(() => new Set(layout.unplaced), [layout.unplaced]);

  // 下絵の画像（この端末に保存）
  const [image, setImage] = useState<UnderlayImage | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [showUnderlay, setShowUnderlay] = useState(true);
  useEffect(() => {
    loadUnderlayImage().then((img) => img && setImage(img));
  }, []);

  const [message, setMessage] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"unplaced" | "placed" | "all">("unplaced");
  const [search, setSearch] = useState("");
  const [showJunctions, setShowJunctions] = useState(false);
  const [practiceArea, setPracticeArea] = useState("");

  const areas = useMemo(() => [...new Set(facility.nodes.map((n) => n.area))], [facility]);
  const q = normalize(search);
  const list = facility.nodes
    .filter((n) => showJunctions || n.kind !== "junction")
    .filter((n) => (tab === "unplaced" ? unplaced.has(n.id) : tab === "placed" ? !unplaced.has(n.id) : true))
    .filter((n) => !q || normalize(n.id).includes(q) || normalize(n.name).includes(q))
    .sort((a, b) => a.area.localeCompare(b.area, "ja") || a.id.localeCompare(b.id, "ja", { numeric: true }));
  const unplacedCount = layout.unplaced.length;

  // ───── 下絵の読み込み ─────
  async function applyImage(img: UnderlayImage, setting?: Partial<UnderlaySetting>) {
    await saveUnderlayImage(img);
    setImage(img);
    setShowUnderlay(true);
    edit((l) => ({
      ...l,
      underlay: {
        x: setting?.x ?? 0,
        y: setting?.y ?? 0,
        width: setting?.width ?? facility.width,
        height: setting?.height ?? (facility.width * img.height) / img.width,
        opacity: l.underlay?.opacity ?? 0.6,
        name: img.name,
      },
    }));
  }

  async function loadSample() {
    setLoadingImage(true);
    setMessage({ type: "info", text: "サンプル図面（PDF）を読み込んでいます…" });
    try {
      const [pdf, align] = await Promise.all([
        fetch(SAMPLE_PDF).then((r) => r.arrayBuffer()),
        fetch(SAMPLE_ALIGN).then((r) => r.json()),
      ]);
      const img = await pdfToImage(pdf, "仮想空港給油施設 配管系統図（サンプル）.pdf");
      // サンプル図面は系統図と同じ座標で作図しているので、位置合わせ情報どおりに重ねる
      await applyImage(img, { x: align.x, y: align.y, width: align.width, height: align.height });
      setMessage({ type: "ok", text: "サンプル図面を下絵にしました。機器の位置が図面と重なることを確認できます。" });
    } catch (e) {
      setMessage({ type: "err", text: `図面を読み込めませんでした：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setLoadingImage(false);
    }
  }

  async function loadFile(file: File) {
    setLoadingImage(true);
    setMessage({ type: "info", text: `${file.name} を読み込んでいます…` });
    try {
      const img = /\.pdf$/i.test(file.name)
        ? await pdfToImage(await file.arrayBuffer(), file.name)
        : await imageFileToUnderlay(file);
      await applyImage(img);
      setMessage({
        type: "ok",
        text: "下絵を読み込みました。必要なら左の「下絵の位置・大きさ」で合わせてから、機器を配置してください。",
      });
    } catch (e) {
      setMessage({ type: "err", text: `図面を読み込めませんでした：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setLoadingImage(false);
    }
  }

  function setUnderlay(patch: Partial<UnderlaySetting>) {
    if (!layout.underlay) return;
    const next = { ...layout.underlay, ...patch };
    // 幅を変えたら、縦横比を保って高さも変える
    if (patch.width !== undefined && image) next.height = (patch.width * image.height) / image.width;
    edit((l) => ({ ...l, underlay: next }));
  }

  // ───── 配置 ─────
  function place(x: number, y: number) {
    if (!selected) {
      setMessage({ type: "info", text: "先に左の一覧（または図面上）で配置する機器を選んでください。" });
      return;
    }
    const pos: [number, number] = [Math.round(x / 5) * 5, Math.round(y / 5) * 5];
    const rest = layout.unplaced.filter((id) => id !== selected);
    edit((l) => ({ ...l, positions: { ...l.positions, [selected]: pos }, unplaced: rest }));
    // 未配置の一覧から選んでいた場合は、次の未配置の機器を自動で選ぶ
    if (tab === "unplaced") {
      const next = list.find((n) => n.id !== selected && rest.includes(n.id));
      setSelected(next?.id ?? null);
      setMessage({ type: "ok", text: `${selected} を配置しました${next ? `。次は ${next.id} です` : "。未配置の機器はありません"}` });
    } else {
      setMessage({ type: "ok", text: `${selected} を移動しました` });
    }
  }

  function unplace(ids: string[]) {
    edit((l) => ({ ...l, unplaced: [...new Set([...l.unplaced, ...ids])] }));
  }

  async function save() {
    try {
      await act({ action: "setLayout", layout });
      setDraft(null);
      setMessage({
        type: "ok",
        text:
          unplacedCount > 0
            ? `配置を保存しました（未配置 ${unplacedCount} 件は元の位置のまま表示されます）。`
            : "配置を保存しました。全画面の系統図に反映されます。",
      });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }

  const marks: Record<string, NodeMark> = selected ? { [selected]: "selected" } : {};
  const sel = selected ? graph.nodeById.get(selected) : undefined;
  const u = layout.underlay;

  return (
    <main className="min-h-screen bg-zinc-50 px-3 py-4 dark:bg-black">
      <div className="mx-auto max-w-[1900px]">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← 配管系統図メニュー
          </Link>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">図面の下絵で機器を配置</h1>
          <span className="text-xs text-zinc-500">
            未配置 {unplacedCount} 件{dirty && <span className="ml-2 font-semibold text-amber-600">● 未保存の変更があります</span>}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setDraft(null)}
              disabled={!dirty}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
            >
              変更を取り消す
            </button>
            <button
              onClick={save}
              disabled={!dirty}
              className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              配置を保存
            </button>
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        {message && (
          <p
            className={`mt-2 rounded-lg px-3 py-2 text-sm ${
              message.type === "ok"
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                : message.type === "err"
                  ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                  : "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200"
            }`}
          >
            {message.text}
          </p>
        )}

        <div className="mt-3 grid gap-3 xl:grid-cols-[340px_1fr]">
          <aside className="space-y-3">
            <Panel title="① 下絵（図面）">
              <p className="text-xs text-zinc-500">
                系統図のPDF・画像（スキャン・写真も可）を下絵にします。画像はこの端末のブラウザに保存されます。
              </p>
              <div className="mt-2 grid gap-2">
                <button
                  onClick={loadSample}
                  disabled={loadingImage}
                  className="rounded-lg bg-sky-600 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  サンプル図面（仮想空港）を読み込む
                </button>
                <label className="block rounded-lg border border-dashed border-zinc-300 p-2 text-center text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                  PDF・画像ファイルを選ぶ
                  <input
                    type="file"
                    accept=".pdf,image/*"
                    className="mt-1 block w-full text-xs"
                    disabled={loadingImage}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) loadFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <a href={SAMPLE_PDF} target="_blank" rel="noreferrer" className="text-center text-xs text-sky-700 underline dark:text-sky-400">
                  サンプル図面（PDF）を開く・ダウンロード
                </a>
              </div>
              {u && (
                <div className="mt-3 space-y-2 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800">
                  <p className="truncate text-zinc-600 dark:text-zinc-400" title={u.name}>
                    下絵：{u.name}
                    {!image && <span className="ml-1 text-amber-600">（この端末に画像がありません。読み込み直してください）</span>}
                  </p>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={showUnderlay} onChange={(e) => setShowUnderlay(e.target.checked)} />
                    下絵を表示
                  </label>
                  <label className="block">
                    濃さ {Math.round(u.opacity * 100)}%
                    <input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={u.opacity}
                      onChange={(e) => setUnderlay({ opacity: Number(e.target.value) })}
                      className="w-full"
                    />
                  </label>
                  <details>
                    <summary className="cursor-pointer text-zinc-500">下絵の位置・大きさ</summary>
                    <div className="mt-1 grid grid-cols-3 gap-1">
                      {(["x", "y", "width"] as const).map((k) => (
                        <label key={k} className="space-y-0.5">
                          <span className="block text-zinc-400">{k === "width" ? "幅" : k.toUpperCase()}</span>
                          <input
                            type="number"
                            value={Math.round(u[k])}
                            step={10}
                            onChange={(e) => setUnderlay({ [k]: Number(e.target.value) })}
                            className="w-full rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700"
                          />
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </Panel>

            <Panel title="② 機器を配置">
              <p className="text-xs text-zinc-500">
                一覧（または図面上）で機器を選び、下絵の位置をクリックします。未配置の一覧からは、配置するたびに次の機器が自動で選ばれます。
              </p>
              {sel && (
                <div className="mt-2 rounded-lg border border-cyan-300 bg-cyan-50 p-2 text-xs dark:border-cyan-800 dark:bg-cyan-950">
                  <p className="text-sm font-semibold">{sel.id}</p>
                  <p className="text-zinc-600 dark:text-zinc-400">
                    {sel.name}（{KIND_LABEL[sel.kind]}・{sel.area}）
                  </p>
                  <p className="mt-1 text-cyan-800 dark:text-cyan-300">
                    {unplaced.has(sel.id) ? "未配置：下絵の位置をクリックして配置" : `配置済み（${sel.x}, ${sel.y}）：クリックで移動`}
                  </p>
                  {!unplaced.has(sel.id) && (
                    <button onClick={() => unplace([sel.id])} className="mt-1 text-xs text-zinc-600 underline">
                      未配置に戻す
                    </button>
                  )}
                </div>
              )}
              <div className="mt-2 flex overflow-hidden rounded-lg border border-zinc-300 text-xs dark:border-zinc-700">
                {(
                  [
                    ["unplaced", `未配置（${unplacedCount}）`],
                    ["placed", "配置済み"],
                    ["all", "すべて"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} onClick={() => setTab(k)} className={`flex-1 py-1 ${tab === k ? "bg-zinc-800 text-white" : ""}`}>
                    {label}
                  </button>
                ))}
              </div>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="機器番号・名称で検索"
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
              />
              <label className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
                <input type="checkbox" checked={showJunctions} onChange={(e) => setShowJunctions(e.target.checked)} />
                分岐点も表示
              </label>
              <ul className="mt-2 max-h-[38vh] divide-y divide-zinc-100 overflow-auto text-sm dark:divide-zinc-800">
                {list.length === 0 && (
                  <li className="py-2 text-xs text-zinc-400">{tab === "unplaced" ? "未配置の機器はありません。" : "該当なし"}</li>
                )}
                {list.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => setSelected(n.id)}
                      className={`w-full px-1 py-1 text-left ${selected === n.id ? "bg-cyan-100 dark:bg-cyan-950" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
                    >
                      <span className="font-medium">{n.id}</span>
                      {unplaced.has(n.id) && <span className="ml-1 text-[10px] text-amber-600">未配置</span>}
                      <span className="block truncate text-[11px] text-zinc-500">
                        {KIND_LABEL[n.kind]}・{n.name !== n.id ? n.name : n.area}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="練習・やり直し">
              <p className="text-xs text-zinc-500">
                実施設では、Excelで登録した機器はすべて「未配置」から始まります。区画を未配置に戻すと、その流れを試せます。
              </p>
              <div className="mt-2 flex gap-1">
                <select
                  value={practiceArea}
                  onChange={(e) => setPracticeArea(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-1 py-1 text-xs dark:border-zinc-700"
                >
                  <option value="">区画を選択</option>
                  {areas.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
                <button
                  disabled={!practiceArea}
                  onClick={() => {
                    unplace(facility.nodes.filter((n) => n.area === practiceArea && n.kind !== "junction").map((n) => n.id));
                    setTab("unplaced");
                  }}
                  className="rounded border border-zinc-300 px-2 text-xs disabled:opacity-40 dark:border-zinc-700"
                >
                  未配置に戻す
                </button>
              </div>
              <button
                onClick={() => {
                  if (confirm("すべての機器を初期の位置に戻しますか？（保存するまで反映されません）"))
                    edit((l) => ({ ...l, positions: {}, unplaced: [] }));
                }}
                className="mt-2 w-full rounded border border-zinc-300 py-1 text-xs dark:border-zinc-700"
              >
                すべて初期の位置に戻す
              </button>
            </Panel>
          </aside>

          <section className="min-w-0">
            <PipingDiagram
              graph={graph}
              valveState={valveState}
              marks={marks}
              clickableKinds={Object.keys(KIND_LABEL) as NodeKind[]}
              onNodeClick={(id) => setSelected(id)}
              onCanvasClick={place}
              hiddenNodeIds={unplaced}
              underlay={u && image && showUnderlay ? { href: image.dataUrl, ...u } : null}
              height="80vh"
            />
            <p className="mt-1 text-xs text-zinc-500">
              水色の丸＝選択中の機器。未配置の機器（とつながる配管）は図面に表示しません。配置すると、つながる配管は直角に引き直します（配管の長さ＝抜取量の計算は変わりません）。
            </p>
          </section>
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
