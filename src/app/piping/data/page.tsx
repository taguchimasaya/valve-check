"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import PipingDiagram from "@/components/piping/PipingDiagram";
import { buildGraph, normalValveState } from "@/lib/piping/graph";
import {
  diagramToFacility,
  diagramToWorkbook,
  validateDiagram,
  workbookToDiagram,
  type DiagramData,
  type Issue,
} from "@/lib/piping/diagramData";
import { selectFacility, useDiagramInfo } from "@/lib/piping/usePiping";
import FacilitySwitcher from "@/components/piping/FacilitySwitcher";

// ④ 系統図データ管理：系統図の版の一覧、Excel での書き出し・取り込み（下書きの版として登録）、使用中への切り替え。

type Version = {
  id: string;
  version_no: number;
  status: "draft" | "active" | "retired";
  note: string | null;
  effective_from: string | null;
  created_at: string;
  nodes: number;
  pipes: number;
  errors: number;
  warnings: number;
};

const STATUS: Record<Version["status"], { label: string; cls: string }> = {
  active: { label: "使用中", cls: "bg-emerald-600 text-white" },
  draft: { label: "下書き", cls: "bg-amber-400 text-zinc-900" },
  retired: { label: "保管", cls: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { issues: body.issues as Issue[] | undefined });
  return body as T;
}

export default function DiagramDataPage() {
  const info = useDiagramInfo();
  const facilityId = info.facilityId;
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 取り込み中のファイル
  const [draft, setDraft] = useState<{ name: string; data: DiagramData; issues: Issue[] } | null>(null);
  const [note, setNote] = useState("");
  // プレビュー（取り込み中のファイル、または登録済みの版）
  const [preview, setPreview] = useState<{ title: string; data: DiagramData } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ versions: Version[] }>(`/api/piping/diagram/versions?facility=${encodeURIComponent(facilityId)}`);
      setVersions(r.versions);
    } catch (e) {
      setMessage({ type: "err", text: `版の一覧を読み込めませんでした：${e instanceof Error ? e.message : String(e)}` });
    }
  }, [facilityId]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function fetchVersion(v: Version) {
    return api<DiagramData>(`/api/piping/diagram/versions?version=${encodeURIComponent(v.id)}`);
  }

  async function exportVersion(v: Version) {
    setBusy(v.id);
    try {
      const data = await fetchVersion(v);
      XLSX.writeFile(diagramToWorkbook(data), `系統図_${data.facility_id}_第${v.version_no}版.xlsx`);
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function previewVersion(v: Version) {
    setBusy(v.id);
    try {
      setPreview({ title: `第${v.version_no}版（${STATUS[v.status].label}）`, data: await fetchVersion(v) });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function readFile(file: File) {
    setMessage(null);
    setPreview(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer());
      const { data, issues } = workbookToDiagram(wb);
      // 読み込みで問題がなければ、系統図としてのチェックもする
      const all = issues.some((i) => i.severity === "error") ? issues : [...issues, ...validateDiagram(data)];
      setDraft({ name: file.name, data, issues: all });
      setNote(data.note ?? "");
    } catch (e) {
      setMessage({ type: "err", text: `ファイルを読み込めませんでした：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function register() {
    if (!draft) return;
    setBusy("import");
    try {
      const r = await api<{ versionId: string; versionNo: number; warnings: number }>("/api/piping/diagram/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import", data: { ...draft.data, note: note.trim() || null } }),
      });
      const other = draft.data.facility_id !== facilityId;
      setMessage({
        type: "ok",
        text: `${other ? `拠点「${draft.data.facility_name}」の` : ""}第${r.versionNo}版（下書き）として登録しました${r.warnings ? `（注意 ${r.warnings} 件）` : ""}。${
          other ? "上の「拠点」をその拠点に切り替えると、版の一覧に出ます。" : "図面で確認してから「使用中にする」を押してください。"
        }`,
      });
      setDraft(null);
      await load();
      if (other && confirm(`拠点「${draft.data.facility_name}」に切り替えますか？`)) selectFacility(draft.data.facility_id);
    } catch (e) {
      const issues = (e as { issues?: Issue[] }).issues;
      if (issues && draft) setDraft({ ...draft, issues });
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function act(v: Version, action: "activate" | "delete") {
    const ask =
      action === "activate"
        ? `第${v.version_no}版を使用中にしますか？\n今の使用中の版は「保管」になり、全画面の系統図がこの版に切り替わります。`
        : `第${v.version_no}版（下書き）を削除しますか？元に戻せません。`;
    if (!confirm(ask)) return;
    setBusy(v.id);
    try {
      await api("/api/piping/diagram/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, versionId: v.id }),
      });
      setMessage({
        type: "ok",
        text:
          action === "activate"
            ? `第${v.version_no}版を使用中にしました。各画面は再読み込みすると新しい版で表示されます。`
            : `第${v.version_no}版を削除しました。`,
      });
      await load();
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  function downloadBlank() {
    const empty: DiagramData = {
      facility_id: facilityId,
      facility_name: "",
      note: null,
      sheets: [{ sheet_no: "S1", title: "全体系統図", width: 2700, height: 1500, meters_per_unit: null, source_doc_no: null }],
      areas: [],
      nodes: [],
      symbols: [],
      pipes: [],
      geometries: [],
      specs: [],
    };
    XLSX.writeFile(diagramToWorkbook(empty), `系統図_登録シート_空.xlsx`);
  }

  const errors = draft?.issues.filter((i) => i.severity === "error") ?? [];
  const warnings = draft?.issues.filter((i) => i.severity === "warning") ?? [];

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← 配管系統図メニュー
          </Link>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">④ 系統図データ管理</h1>
            <FacilitySwitcher />
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            系統図は「版」ごとに保存します。Excel で書き出して編集し、取り込むと新しい版（下書き）になります。
            図面で確認してから「使用中にする」と、全画面の系統図が切り替わります。今までの版は「保管」として残ります。
          </p>
        </div>

        {message && (
          <div
            className={`whitespace-pre-line rounded-lg px-3 py-2 text-sm ${
              message.type === "ok"
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
            }`}
          >
            {message.text}
          </div>
        )}

        <Panel title={`版の一覧（施設：${facilityId}）`}>
          {versions === null ? (
            <p className="text-sm text-zinc-500">読み込み中…</p>
          ) : versions.length === 0 ? (
            <p className="text-sm text-zinc-500">まだ版がありません。下で Excel を取り込んでください。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-zinc-500">
                  <tr>
                    <th className="py-1 font-normal">版</th>
                    <th className="font-normal">状態</th>
                    <th className="font-normal">メモ</th>
                    <th className="text-right font-normal">機器</th>
                    <th className="text-right font-normal">配管</th>
                    <th className="font-normal">入力チェック</th>
                    <th className="font-normal">登録日／使用開始日</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-2 font-semibold">第{v.version_no}版</td>
                      <td>
                        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS[v.status].cls}`}>{STATUS[v.status].label}</span>
                      </td>
                      <td className="max-w-56 truncate text-zinc-600 dark:text-zinc-400" title={v.note ?? ""}>
                        {v.note ?? "—"}
                      </td>
                      <td className="text-right">{v.nodes}</td>
                      <td className="text-right">{v.pipes}</td>
                      <td className="text-xs">
                        {v.errors ? <span className="text-red-600">エラー {v.errors}</span> : null}
                        {v.warnings ? <span className="ml-1 text-amber-700">注意 {v.warnings}</span> : null}
                        {!v.errors && !v.warnings ? <span className="text-zinc-400">なし</span> : null}
                      </td>
                      <td className="text-xs text-zinc-500">
                        {new Date(v.created_at).toLocaleDateString("ja-JP")}
                        {v.effective_from ? ` ／ ${v.effective_from}` : ""}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1">
                          <SmallButton onClick={() => previewVersion(v)} disabled={busy !== null}>
                            図面で確認
                          </SmallButton>
                          <SmallButton onClick={() => exportVersion(v)} disabled={busy !== null}>
                            Excel出力
                          </SmallButton>
                          {v.status === "draft" && (
                            <>
                              <SmallButton onClick={() => act(v, "activate")} disabled={busy !== null} primary>
                                使用中にする
                              </SmallButton>
                              <SmallButton onClick={() => act(v, "delete")} disabled={busy !== null} danger>
                                削除
                              </SmallButton>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            設備を更新したときは、使用中の版を「Excel出力」して変更箇所を直し、取り込んでください。機器番号・配管番号は変えずに残すと、過去のチェックリストとのつながりが保てます。
          </p>
        </Panel>

        <Panel title="Excel を取り込む（新しい版の下書きを作る）">
          <div className="flex flex-wrap items-center gap-3">
            <label className="cursor-pointer rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600">
              Excel ファイルを選ぶ
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) readFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            <button onClick={downloadBlank} className="text-sm text-sky-700 underline dark:text-sky-400">
              空の登録シートをダウンロード
            </button>
          </div>

          {draft && (
            <div className="mt-4 space-y-3">
              <p className="text-sm">
                <b>{draft.name}</b>：施設 {draft.data.facility_id}、図面シート {draft.data.sheets.length}枚、機器 {draft.data.nodes.length}件、配管{" "}
                {draft.data.pipes.length}本、配管仕様 {draft.data.specs.length}件
              </p>
              {draft.data.facility_id !== facilityId && (
                <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  施設ID「{draft.data.facility_id}」は、今表示している施設（{facilityId}）と違います。別の施設の版として登録されます。
                </p>
              )}
              <IssueList errors={errors} warnings={warnings} />
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="版のメモ（例：P-13 更新に伴う配管変更）"
                  className="min-w-72 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
                />
                <button
                  onClick={() => setPreview({ title: `取り込み中：${draft.name}`, data: draft.data })}
                  disabled={errors.length > 0}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
                >
                  図面で確認
                </button>
                <button
                  onClick={register}
                  disabled={errors.length > 0 || busy !== null}
                  className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  下書きの版として登録
                </button>
                <button onClick={() => setDraft(null)} className="text-sm text-zinc-500 underline">
                  取り消す
                </button>
              </div>
              {errors.length > 0 && <p className="text-xs text-red-600">エラーを Excel で直してから、もう一度取り込んでください。</p>}
            </div>
          )}
        </Panel>

        {preview && <Preview title={preview.title} data={preview.data} onClose={() => setPreview(null)} />}
      </div>
    </main>
  );
}

function IssueList({ errors, warnings }: { errors: Issue[]; warnings: Issue[] }) {
  if (!errors.length && !warnings.length) {
    return <p className="rounded bg-emerald-50 px-2 py-1 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">入力チェック：問題はありません。</p>;
  }
  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <details open className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          <summary className="cursor-pointer text-sm font-semibold">エラー {errors.length} 件（登録できません）</summary>
          <ul className="mt-1 list-disc pl-5">
            {errors.slice(0, 200).map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
          {errors.length > 200 && <p>ほか {errors.length - 200} 件</p>}
        </details>
      )}
      {warnings.length > 0 && (
        <details className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <summary className="cursor-pointer text-sm font-semibold">注意 {warnings.length} 件（登録はできます）</summary>
          <ul className="mt-1 list-disc pl-5">
            {warnings.slice(0, 200).map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
          {warnings.length > 200 && <p>ほか {warnings.length - 200} 件</p>}
        </details>
      )}
    </div>
  );
}

function Preview({ title, data, onClose }: { title: string; data: DiagramData; onClose: () => void }) {
  const [sheetNo, setSheetNo] = useState(data.sheets[0]?.sheet_no ?? "");
  const built = useMemo(() => {
    try {
      const facility = diagramToFacility(data, sheetNo);
      return { graph: buildGraph(facility), error: null };
    } catch (e) {
      return { graph: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [data, sheetNo]);
  const valveState = useMemo(() => (built.graph ? normalValveState(built.graph.facility) : {}), [built.graph]);
  return (
    <Panel title={`図面で確認：${title}`}>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        {data.sheets.length > 1 && (
          <label className="flex items-center gap-1">
            図面シート
            <select value={sheetNo} onChange={(e) => setSheetNo(e.target.value)} className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
              {data.sheets.map((s) => (
                <option key={s.sheet_no} value={s.sheet_no}>
                  {s.sheet_no} {s.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {built.graph && (
          <span className="text-zinc-500">
            区間 {built.graph.sections.length}・弁の色は待機状態（緑＝開、赤＝閉）
          </span>
        )}
        <button onClick={onClose} className="ml-auto text-zinc-500 underline">
          閉じる
        </button>
      </div>
      {built.graph ? (
        <PipingDiagram graph={built.graph} valveState={valveState} height="70vh" />
      ) : (
        <p className="text-sm text-red-600">図面を作れませんでした：{built.error}</p>
      )}
    </Panel>
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

function SmallButton({
  onClick,
  disabled,
  primary,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-2 py-1 text-xs disabled:opacity-40 ${
        primary
          ? "bg-emerald-700 font-semibold text-white hover:bg-emerald-600"
          : danger
            ? "border border-red-300 text-red-700 dark:border-red-900 dark:text-red-400"
            : "border border-zinc-300 dark:border-zinc-700"
      }`}
    >
      {children}
    </button>
  );
}
