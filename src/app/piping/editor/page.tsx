"use client";

import { Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import PipingDiagram, { type DiagramEdit } from "@/components/piping/PipingDiagram";
import { buildGraph, normalValveState } from "@/lib/piping/graph";
import { diagramToFacility, KIND_LABEL, validateDiagram, type DiagramData, type Issue, type NodeData, type PipeData } from "@/lib/piping/diagramData";
import {
  addVia,
  diffDiagram,
  addNode,
  branchFrom,
  connectNodes,
  deleteImpact,
  deleteNode,
  deleteArea,
  deletePipe,
  fitBox,
  framesOf,
  renameArea,
  setAreaBox,
  unframedAreas,
  elbow,
  junctionOnPipe,
  orphanJunctions,
  pipesOf,
  pruneOrphanJunctions,
  insertOnPipe,
  isEmptyDiff,
  moveNode,
  normalizeDiagram,
  pipePath,
  renameNode,
  setVia,
  suggestNodeCode,
  updateNode,
  updatePipe,
  viaOf,
} from "@/lib/piping/diagramEdit";
import { FLUID_LABEL, type Fluid, type NodeKind } from "@/lib/piping/types";
import { authFetch } from "@/lib/auth";

// ④ 系統図エディタ：版の中身を図面上で編集し、新しい版（下書き）として保存する。
// 第1段階：機器・経由点の移動、配管の途中への弁などの挿入、属性の編集、元に戻す／やり直し、下書き保存。
// 保存は Excel 取込と同じ API（入力チェック → 下書きの版）。使用中への切り替えは ④ 系統図データ管理で行う。

type Sel = { type: "node" | "pipe"; id: string } | null;
type Tool =
  | { mode: "inline" | "branch" | "place"; kind: NodeKind }
  | { mode: "pipe"; from: string | null }
  /** 区画枠の編集（newName があれば、次に空き場所をクリックした位置にその区画の枠を作る） */
  | { mode: "area"; newName?: string }
  | null;

/** 追加する機器の種別の並び（まとまりごと） */
const KIND_GROUPS: { label: string; kinds: NodeKind[] }[] = [
  { label: "弁・配管の機器", kinds: ["valve", "check", "strainer", "filter", "junction"] },
  { label: "タンク・ポンプ", kinds: ["tank", "pump", "transferPump"] },
  { label: "安全弁・ドレン・計器", kinds: ["psv", "drain", "gauge"] },
  { label: "受入・払出", kinds: ["source", "sink"] },
  { label: "消火設備", kinds: ["hydrant", "monitor", "sprinkler", "proportioner", "foamChamber"] },
];
type VersionInfo = { id: string; version_no: number; status: "draft" | "active" | "retired" };

const GRID = 10;
const PIPE_SIZES = [15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300];
const HISTORY_MAX = 100;

export default function DiagramEditorPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-zinc-500">読み込み中…</div>}>
      <Editor />
    </Suspense>
  );
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { issues: body.issues as Issue[] | undefined });
  return body as T;
}

function Editor() {
  const params = useSearchParams();
  const versionId = params.get("version");
  const [base, setBase] = useState<DiagramData | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [data, setData] = useState<DiagramData | null>(null);
  const [past, setPast] = useState<DiagramData[]>([]);
  const [future, setFuture] = useState<DiagramData[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheetNo, setSheetNo] = useState("");
  const [sel, setSel] = useState<Sel>(null);
  // 道具：配管の途中に入れる／枝を出して付ける／空き場所に置く（種別つき）、配管を引く（始点）
  const [tool, setTool] = useState<Tool>(null);
  const [kind, setKind] = useState<NodeKind>("valve");
  const [pipeSize, setPipeSize] = useState<number | null>(null);
  const [selArea, setSelArea] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [newCodes, setNewCodes] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ versionNo: number } | null>(null);
  const [note, setNote] = useState("");

  // 編集中のデータ（イベント処理から最新の値を読むため ref にも持つ）
  const dataRef = useRef<DiagramData | null>(null);

  // ───── 読み込み ─────
  useEffect(() => {
    if (!versionId) return;
    let alive = true;
    (async () => {
      try {
        const raw = normalizeDiagram(await api<DiagramData>(`/api/piping/diagram/versions?version=${encodeURIComponent(versionId)}`));
        const list = await api<{ versions: VersionInfo[] }>(`/api/piping/diagram/versions?facility=${encodeURIComponent(raw.facility_id)}`);
        if (!alive) return;
        const v = list.versions.find((x) => x.id === versionId) ?? null;
        setBase(raw);
        dataRef.current = raw;
        setData(raw);
        setVersion(v);
        setSheetNo(raw.sheets[0]?.sheet_no ?? "");
        setNote(v ? `第${v.version_no}版をエディタで編集` : "エディタで編集");
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [versionId]);

  // ───── 変更と元に戻す ─────

  // 履歴は ref を正とし、ボタンの表示用に state へも写す
  const pastRef = useRef<DiagramData[]>([]);
  const futureRef = useRef<DiagramData[]>([]);
  const setHistory = useCallback((p: DiagramData[], f: DiagramData[]) => {
    pastRef.current = p;
    futureRef.current = f;
    setPast(p);
    setFuture(f);
  }, []);
  const showData = useCallback((d: DiagramData) => {
    dataRef.current = d;
    setData(d);
  }, []);

  /** 変更を確定する（元に戻す履歴に積む） */
  const commit = useCallback(
    (next: DiagramData) => {
      const cur = dataRef.current;
      if (!cur || next === cur) return;
      setHistory([...pastRef.current.slice(-(HISTORY_MAX - 1)), cur], []);
      showData(next);
      setSaved(null);
    },
    [setHistory, showData]
  );

  const undo = useCallback(() => {
    const p = pastRef.current;
    if (!p.length || !dataRef.current) return;
    setHistory(p.slice(0, -1), [dataRef.current, ...futureRef.current]);
    showData(p[p.length - 1]);
  }, [setHistory, showData]);
  const redo = useCallback(() => {
    const f = futureRef.current;
    if (!f.length || !dataRef.current) return;
    setHistory([...pastRef.current, dataRef.current], f.slice(1));
    showData(f[0]);
  }, [setHistory, showData]);

  // ドラッグ：最初の移動で履歴に積み、その後は描画のたびに位置だけ更新する
  const dragging = useRef(false);
  const pending = useRef<((d: DiagramData) => DiagramData) | null>(null);
  const frame = useRef<number | null>(null);
  const snapTo = useCallback((v: number) => (snap ? Math.round(v / GRID) * GRID : Math.round(v)), [snap]);
  const dragUpdate = useCallback((fn: (d: DiagramData) => DiagramData) => {
    if (!dragging.current && dataRef.current) {
      dragging.current = true;
      setHistory([...pastRef.current.slice(-(HISTORY_MAX - 1)), dataRef.current], []);
      setSaved(null);
    }
    pending.current = fn;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const f = pending.current;
      pending.current = null;
      if (f && dataRef.current) showData(f(dataRef.current));
    });
  }, [setHistory, showData]);

  // ───── キーボード（Ctrl+Z／Ctrl+Y・Esc・Delete） ─────
  const endPipeToolRef = useRef<() => void>(() => {});
  const removeRef = useRef<(reconnect: boolean | null) => void>(() => {});
  const selRef = useRef<Sel>(null);
  useEffect(() => {
    endPipeToolRef.current = endPipeTool;
    removeRef.current = removeSelected;
    selRef.current = sel;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Esc は入力欄・選択欄にいても効かせる（種別を選んだ直後でも配管を引くのをやめられるように）
      if (e.key === "Escape" && t && (t.tagName === "INPUT" || t.tagName === "SELECT")) t.blur();
      else if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Escape") {
        endPipeToolRef.current();
        setSel(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selRef.current) {
        e.preventDefault();
        removeRef.current(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // 保存していない変更があるときは、ページを離れる前に確認する
  const diff = useMemo(() => (base && data ? diffDiagram(base, data) : null), [base, data]);
  const dirty = !!diff && !isEmptyDiff(diff) && !saved;
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);

  // ───── 図面 ─────
  const built = useMemo(() => {
    if (!data) return null;
    try {
      return { graph: buildGraph(diagramToFacility(data, sheetNo)), error: null };
    } catch (e) {
      return { graph: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [data, sheetNo]);
  const valveState = useMemo(() => (built?.graph ? normalValveState(built.graph.facility) : {}), [built]);

  // 入力チェック（ドラッグ中は少し遅れて計算する）
  const deferred = useDeferredValue(data);
  const issues = useMemo(() => (deferred ? validateDiagram(deferred) : []), [deferred]);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const problemIds = useMemo(
    () => new Set(errors.filter((i) => (i.target_type === "node" || i.target_type === "pipe") && i.target_code).map((i) => i.target_code!)),
    [errors]
  );

  // ───── 追加・接続の道具 ─────
  const fail = (text: string) => setMessage({ type: "err", text });
  const added = (codes: string[]) => setNewCodes((s) => new Set([...s, ...codes]));
  const symPos = (d: DiagramData, code: string): [number, number] | null => {
    const s = d.symbols.find((x) => x.sheet_no === sheetNo && x.node_code === code);
    return s ? [s.x, s.y] : null;
  };

  /** 配管を引く：端点（機器）を1つ進める。from が無ければ始点にする */
  function pipeStep(cur: DiagramData, end: string, extraNew: string[], finish: boolean) {
    if (tool?.mode !== "pipe") return;
    if (!tool.from) {
      if (cur !== dataRef.current) commit(cur);
      added(extraNew);
      setTool({ mode: "pipe", from: end });
      setMessage({ type: "ok", text: `${end} から配管を引きます。次の機器・配管・空き場所をクリックしてください（Esc で終わる）。` });
      return;
    }
    // 縦横がそろっていなければ、直角に曲げて引く（曲がり角はあとでドラッグで直せる）
    const pa = symPos(cur, tool.from);
    const pb = symPos(cur, end);
    const c = connectNodes(cur, sheetNo, tool.from, end, { sizeA: pipeSize ?? undefined, via: pa && pb ? elbow(pa, pb) : [] });
    if (typeof c === "string") return fail(c);
    commit(c.data);
    added(extraNew);
    setTool(finish ? null : { mode: "pipe", from: end });
    setSel({ type: "pipe", id: c.code });
    setMessage({
      type: "ok",
      text: `配管 ${c.code}（${tool.from} → ${end}）を追加しました。${finish ? "" : "続けて次の点をクリックすると配管がつながります（Esc で終わる）。"}`,
    });
  }

  /** 配管を引くのをやめる（始点だけ作って配管が1本も無い分岐点は消す） */
  function endPipeTool() {
    const cur = dataRef.current;
    if (tool?.mode === "pipe" && tool.from && cur) {
      const n = cur.nodes.find((x) => x.code === tool.from);
      if (n?.kind === "junction" && !pipesOf(cur, n.code).length) showData(pruneOrphanJunctions(cur));
    }
    setTool(null);
  }

  function onPipePoint(pipeId: string, x: number, y: number) {
    const cur = dataRef.current!;
    const [px, py] = [snapTo(x), snapTo(y)];
    if (tool?.mode === "inline") {
      const r = insertOnPipe(cur, sheetNo, pipeId, px, py, { kind: tool.kind, code: suggestNodeCode(cur, tool.kind) });
      if (typeof r === "string") return fail(r);
      commit(r.data);
      added([r.nodeCode]);
      setSel({ type: "node", id: r.nodeCode });
      setTool(null);
      setMessage({
        type: "ok",
        text: `${KIND_LABEL[tool.kind]} ${r.nodeCode} を配管 ${pipeId} の途中に入れました（配管は ${pipeId} と ${r.newPipeCode} に分かれました）。右の欄で番号・名称などを確かめてください。`,
      });
    } else if (tool?.mode === "branch") {
      const r = branchFrom(cur, sheetNo, { type: "pipe", id: pipeId, x: px, y: py }, tool.kind);
      if (typeof r === "string") return fail(r);
      commit(r.data);
      added(r.data.nodes.filter((n) => !cur.nodes.some((m) => m.code === n.code)).map((n) => n.code));
      setSel({ type: "node", id: r.code });
      setTool(null);
      setMessage({ type: "ok", text: `配管 ${pipeId} から枝管 ${r.pipeCode} を出し、${KIND_LABEL[tool.kind]} ${r.code} を付けました。ドラッグで位置を直せます。` });
    } else if (tool?.mode === "pipe") {
      // 配管の途中を端点にする：そこに分岐点を作る（始点なら続けて引ける・終点ならそこで終わる）
      const j = junctionOnPipe(cur, sheetNo, pipeId, px, py);
      if (typeof j === "string") return fail(j);
      pipeStep(j.data, j.nodeCode, [j.nodeCode], !!tool.from);
    }
  }

  function onNodePick(id: string) {
    const cur = dataRef.current!;
    if (tool?.mode === "branch") {
      const r = branchFrom(cur, sheetNo, { type: "node", id }, tool.kind);
      if (typeof r === "string") return fail(r);
      commit(r.data);
      added([r.code]);
      setSel({ type: "node", id: r.code });
      setTool(null);
      setMessage({ type: "ok", text: `${id} から枝管 ${r.pipeCode} を出し、${KIND_LABEL[tool.kind]} ${r.code} を付けました。ドラッグで位置を直せます。` });
    } else if (tool?.mode === "pipe") {
      pipeStep(cur, id, [], !!tool.from);
    }
  }

  function onCanvasPoint(x: number, y: number) {
    const cur = dataRef.current!;
    const [px, py] = [snapTo(x), snapTo(y)];
    if (tool?.mode === "area" && tool.newName) {
      const name = tool.newName;
      commit(setAreaBox(cur, sheetNo, name, { x: px, y: py, w: 400, h: 250 }));
      setSelArea(name);
      setTool({ mode: "area" });
      setMessage({ type: "ok", text: `区画「${name}」の枠を作りました。線をドラッグで移動、右下の角で大きさを変えられます。` });
      return;
    }
    if (tool?.mode === "place") {
      const r = addNode(cur, sheetNo, tool.kind, px, py);
      commit(r.data);
      added([r.code]);
      setSel({ type: "node", id: r.code });
      setTool(null);
      setMessage({ type: "ok", text: `${KIND_LABEL[tool.kind]} ${r.code} を置きました。「配管を引く」で他の機器とつないでください。` });
    } else if (tool?.mode === "pipe") {
      // 空き場所：曲がり角・行き止まりとして分岐点を作る
      const r = addNode(cur, sheetNo, "junction", px, py, tool.from ?? undefined);
      pipeStep(r.data, r.code, [r.code], false);
    }
  }

  const rubberFrom = tool?.mode === "pipe" && tool.from && data ? symPos(data, tool.from) : null;

  /** 選択中の機器・配管を消す */
  function removeSelected(reconnect: boolean | null) {
    const cur = dataRef.current;
    if (!cur || !sel) return;
    if (sel.type === "pipe") {
      if (!confirm(`配管 ${sel.id} を消しますか？\n両端の機器は残ります。保存済みのチェックリストでこの配管を使っているものは、作り直しが必要になります。`)) return;
      commit(deletePipe(cur, sel.id));
      setSel(null);
      setMessage({ type: "ok", text: `配管 ${sel.id} を消しました（元に戻すで戻せます）。` });
      return;
    }
    const imp = deleteImpact(cur, sel.id);
    const doReconnect = reconnect ?? imp.canReconnect;
    const lines = doReconnect
      ? [`機器 ${sel.id} を消し、両側の配管（${imp.pipes.join("・")}）を1本にまとめます（${imp.pipes[0]} の番号を残します）。`]
      : [`機器 ${sel.id} と、つながっている配管 ${imp.pipes.length ? imp.pipes.join("・") : "（なし）"} を消します。`];
    if (imp.refs.length) lines.push(`この機器を上流側・抜取経路などに使っている機器（${imp.refs.join("・")}）の設定も外します。`);
    lines.push("保存済みのチェックリストでこの機器・配管を使っているものは、作り直しが必要になります。");
    if (!confirm(lines.join("\n"))) return;
    const r = deleteNode(cur, sel.id, doReconnect);
    if (typeof r === "string") return fail(r);
    commit(r);
    setSel(null);
    setMessage({ type: "ok", text: `機器 ${sel.id} を消しました（元に戻すで戻せます）。` });
  }

  const edit: DiagramEdit | undefined = data
    ? {
        selected: sel,
        onSelect: setSel,
        problemIds,
        rubberFrom,
        areas:
          tool?.mode === "area"
            ? {
                selected: selArea,
                onSelect: setSelArea,
                onChange: (name, b) => dragUpdate((d) => setAreaBox(d, sheetNo, name, { x: snapTo(b.x), y: snapTo(b.y), w: snapTo(b.w), h: snapTo(b.h) })),
              }
            : undefined,
        onPipePoint: tool ? onPipePoint : undefined,
        onNodePick: tool?.mode === "branch" || tool?.mode === "pipe" ? onNodePick : undefined,
        onCanvasPoint: tool?.mode === "place" || tool?.mode === "pipe" || (tool?.mode === "area" && tool.newName) ? onCanvasPoint : undefined,
        onNodeMove: (id, x, y) => dragUpdate((d) => moveNode(d, sheetNo, id, snapTo(x), snapTo(y))),
        onViaMove: (pipeId, index, x, y) =>
          dragUpdate((d) => {
            const via = [...viaOf(d, sheetNo, pipeId)];
            via[index] = [snapTo(x), snapTo(y)];
            return setVia(d, sheetNo, pipeId, via);
          }),
        onDragEnd: () => {
          dragging.current = false;
        },
        onViaAdd: (pipeId, x, y) => commit(addVia(dataRef.current!, sheetNo, pipeId, snapTo(x), snapTo(y))),
        onViaRemove: (pipeId, index) => {
          const cur = dataRef.current!;
          commit(setVia(cur, sheetNo, pipeId, viaOf(cur, sheetNo, pipeId).filter((_, i) => i !== index)));
        },
      }
    : undefined;

  // ───── 保存（新しい版の下書き） ─────
  async function save() {
    if (!data || !diff) return;
    const lines = [
      diff.addedNodes.length ? `追加した機器：${diff.addedNodes.join("、")}` : "",
      diff.addedPipes.length ? `増えた配管：${diff.addedPipes.join("、")}` : "",
      diff.removedNodes.length ? `削除した機器：${diff.removedNodes.join("、")}` : "",
      diff.removedPipes.length ? `削除した配管：${diff.removedPipes.join("、")}` : "",
      diff.changedNodes.length ? `属性を変えた機器：${diff.changedNodes.length}件` : "",
      diff.changedPipes.length ? `属性・つながりを変えた配管：${diff.changedPipes.length}件` : "",
      diff.moved ? `位置・経由点を変えた箇所：${diff.moved}件` : "",
      diff.areas ? `区画枠の追加・変更・削除：${diff.areas}件` : "",
    ].filter(Boolean);
    if (!confirm(`新しい版（下書き）として保存しますか？\n\n${lines.join("\n")}\n\n使用中の版は変わりません。④ 系統図データ管理で確認してから「使用中にする」を押してください。`)) return;
    setSaving(true);
    setMessage(null);
    try {
      const r = await api<{ versionId: string; versionNo: number; warnings: number }>("/api/piping/diagram/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import", method: "manual", data: { ...data, note: note.trim() || null } }),
      });
      setSaved({ versionNo: r.versionNo });
      setMessage({ type: "ok", text: `第${r.versionNo}版（下書き）として保存しました${r.warnings ? `（注意 ${r.warnings} 件）` : ""}。④ 系統図データ管理で図面を確認し、「使用中にする」を押すと全画面に反映されます。` });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  /** 道具を選ぶ（同じ道具をもう一度押すと解除） */
  function pick(t: Exclude<Tool, null>) {
    const same = !!tool && tool.mode === t.mode && (!("kind" in t) || ("kind" in tool && tool.kind === t.kind));
    endPipeTool();
    if (!same) setTool(t);
  }
  const toolHint = !tool
    ? ""
    : tool.mode === "inline"
      ? `${KIND_LABEL[tool.kind]}を入れる配管をクリックしてください（Esc で取り消し）`
      : tool.mode === "branch"
        ? `${KIND_LABEL[tool.kind]}を付ける配管（その位置に分岐点を作る）または機器をクリックしてください（Esc で取り消し）`
        : tool.mode === "place"
          ? `${KIND_LABEL[tool.kind]}を置く空き場所をクリックしてください（Esc で取り消し）`
          : tool.mode === "area"
            ? tool.newName
              ? `区画「${tool.newName}」の枠の左上にする位置をクリックしてください（Esc で取り消し）`
              : "区画枠の線・名前をドラッグで移動、選んだ枠の右下の角で大きさを変えます。右の欄で名前・位置の変更、枠の追加・削除ができます"
          : tool.mode === "pipe" && tool.from
            ? `${tool.from} からの配管：次の機器・配管・空き場所（曲がり角）をクリック。機器・配管をクリックするとそこで終わります（Esc で終わる）`
            : "配管の始点（機器・配管の途中・空き場所）をクリックしてください（Esc で取り消し）";

  if (!versionId) return <Shell>編集する版が指定されていません。④ 系統図データ管理の版の一覧から「エディタで編集」を押してください。</Shell>;
  if (loadError) return <Shell>版を読み込めませんでした：{loadError}</Shell>;
  if (!data || !built) return <Shell>読み込み中…</Shell>;

  const selNode = sel?.type === "node" ? data.nodes.find((n) => n.code === sel.id) : undefined;
  const selPipe = sel?.type === "pipe" ? data.pipes.find((p) => p.code === sel.id) : undefined;

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-4 dark:bg-black">
      <div className="mx-auto max-w-[1600px] space-y-3">
        <div>
          <Link href="/piping/data" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← ④ 系統図データ管理
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">系統図エディタ</h1>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {data.facility_name}・第{version?.version_no ?? "?"}版をもとに編集
            </span>
            {dirty && <span className="rounded bg-amber-400 px-2 py-0.5 text-xs font-semibold text-zinc-900">未保存の変更あり</span>}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            機器はドラッグで移動、配管はクリックで選択（選択中の配管をダブルクリックで経由点を追加、経由点のダブルクリックで削除）。
            機器を足すときは「追加する機器」で種別を選び、「配管の途中に入れる」「枝を出して付ける」「空き場所に置く」から付け方を選びます。
            「配管を引く」は機器・配管の途中・空き場所を順にクリックします。撤去した機器・配管は選んで削除します。保存すると新しい版（下書き）になり、使用中の版は変わりません。
          </p>
        </div>

        {message && (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              message.type === "ok" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
            }`}
          >
            {message.text}
            {saved && (
              <Link href="/piping/data" className="ml-2 font-semibold underline">
                ④ 系統図データ管理へ
              </Link>
            )}
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0">
            {/* 追加・接続・削除の道具 */}
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950">
              <label className="flex items-center gap-1">
                追加する機器
                <select value={kind} onChange={(e) => setKind(e.target.value as NodeKind)} className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700">
                  {KIND_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.kinds.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <ToolButton active={tool?.mode === "inline"} onClick={() => pick({ mode: "inline", kind })} title="配管をクリックした位置に入れ、配管を2本に分けます">
                配管の途中に入れる
              </ToolButton>
              <ToolButton active={tool?.mode === "branch"} onClick={() => pick({ mode: "branch", kind })} title="配管（分岐点を作る）または機器をクリックすると、枝管を出してその先に付けます">
                枝を出して付ける
              </ToolButton>
              <ToolButton active={tool?.mode === "place"} onClick={() => pick({ mode: "place", kind })} title="図面の空き場所をクリックして置きます（あとで配管を引いてつなぎます）">
                空き場所に置く
              </ToolButton>
              <span className="mx-1 h-5 border-l border-zinc-300 dark:border-zinc-700" />
              <ToolButton active={tool?.mode === "area"} onClick={() => pick({ mode: "area" })} title="区画の点線の枠を動かす・大きさを変える・作る・消す">
                区画枠を編集
              </ToolButton>
              <ToolButton active={tool?.mode === "pipe"} onClick={() => pick({ mode: "pipe", from: null })} title="機器・配管・空き場所を順にクリックして配管を引きます">
                配管を引く
              </ToolButton>
              <label className="flex items-center gap-1">
                呼び径
                <select
                  value={pipeSize ?? ""}
                  onChange={(e) => setPipeSize(e.target.value ? Number(e.target.value) : null)}
                  className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700"
                >
                  <option value="">つなぐ先と同じ</option>
                  {PIPE_SIZES.map((a) => (
                    <option key={a} value={a}>
                      {a}A
                    </option>
                  ))}
                </select>
              </label>
              <span className="mx-1 h-5 border-l border-zinc-300 dark:border-zinc-700" />
              <button
                onClick={() => removeSelected(null)}
                disabled={!sel}
                className="rounded border border-red-300 px-2 py-0.5 text-red-700 disabled:opacity-40 dark:border-red-900 dark:text-red-400"
                title="選択中の機器・配管を消します（Delete キー）"
              >
                選択中を削除
              </button>
            </div>
            <PipingDiagram
              graph={built.graph!}
              valveState={valveState}
              edit={edit}
              height="calc(100vh - 220px)"
              toolbar={
                <>
                  {data.sheets.length > 1 && (
                    <select value={sheetNo} onChange={(e) => setSheetNo(e.target.value)} className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700">
                      {data.sheets.map((s) => (
                        <option key={s.sheet_no} value={s.sheet_no}>
                          {s.sheet_no} {s.title}
                        </option>
                      ))}
                    </select>
                  )}
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
                    格子にそろえる
                  </label>
                  <button onClick={undo} disabled={!past.length} className="rounded border border-zinc-300 px-2 py-0.5 text-xs disabled:opacity-40 dark:border-zinc-700" title="Ctrl+Z">
                    元に戻す
                  </button>
                  <button onClick={redo} disabled={!future.length} className="rounded border border-zinc-300 px-2 py-0.5 text-xs disabled:opacity-40 dark:border-zinc-700" title="Ctrl+Y">
                    やり直し
                  </button>
                </>
              }
            />
            <p className="mt-1 min-h-4 text-xs font-semibold text-cyan-700 dark:text-cyan-400">{toolHint}</p>
          </div>

          <aside className="space-y-3">
            {tool?.mode === "area" && (
              <Panel title="区画枠">
                <AreaPanel
                  key={`${selArea}|${JSON.stringify(data.areas.find((a) => a.name === selArea) ?? null)}`}
                  data={data}
                  sheetNo={sheetNo}
                  selected={selArea}
                  onSelect={setSelArea}
                  onChange={commit}
                  onNew={(name) => setTool({ mode: "area", newName: name })}
                  onError={(text) => setMessage({ type: "err", text })}
                />
              </Panel>
            )}

            <Panel title="選択中">
              {selNode ? (
                <NodeForm
                  // 元に戻す・ドラッグなどで値が変わったら欄を作り直す（入力中の値を最新にそろえる）
                  key={`${JSON.stringify(selNode)}|${JSON.stringify(data.symbols.find((s) => s.sheet_no === sheetNo && s.node_code === selNode.code) ?? null)}`}
                  data={data}
                  node={selNode}
                  sheetNo={sheetNo}
                  isNew={newCodes.has(selNode.code)}
                  onChange={(next) => commit(next)}
                  onRenamed={(from, to) => {
                    setNewCodes((s) => {
                      const n = new Set(s);
                      n.delete(from);
                      n.add(to);
                      return n;
                    });
                    setSel({ type: "node", id: to });
                  }}
                  onError={(text) => setMessage({ type: "err", text })}
                />
              ) : selPipe ? (
                <PipeForm key={JSON.stringify(selPipe)} data={data} pipe={selPipe} sheetNo={sheetNo} onChange={(next) => commit(next)} />
              ) : (
                <p className="text-sm text-zinc-500">図面の機器・配管をクリックすると、ここで属性を編集できます。</p>
              )}
            </Panel>

            {(selNode || selPipe) && (
              <Panel title="削除（設備の撤去）">
                {selNode ? (
                  <div className="flex flex-wrap gap-2">
                    {deleteImpact(data, selNode.code).canReconnect && (
                      <button onClick={() => removeSelected(true)} className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:text-red-400">
                        機器だけ消して配管をつなぐ
                      </button>
                    )}
                    <button onClick={() => removeSelected(false)} className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:text-red-400">
                      機器と配管 {deleteImpact(data, selNode.code).pipes.length} 本を消す
                    </button>
                  </div>
                ) : (
                  <button onClick={() => removeSelected(false)} className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:text-red-400">
                    この配管を消す
                  </button>
                )}
                <p className="mt-1 text-[11px] text-zinc-500">弁などを撤去して配管がそのまま続く場合は「配管をつなぐ」、設備ごと無くなる場合は「配管を消す」を選びます。元に戻すで戻せます。</p>
              </Panel>
            )}

            <Panel title="入力チェック">
              {orphanJunctions(data).length > 0 && (
                <button
                  onClick={() => {
                    const n = orphanJunctions(data).length;
                    commit(pruneOrphanJunctions(data));
                    setMessage({ type: "ok", text: `どの配管にもつながっていない分岐点 ${n} 件を消しました（元に戻すで戻せます）。` });
                  }}
                  className="mb-2 rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:text-red-400"
                >
                  未接続の分岐点 {orphanJunctions(data).length} 件をまとめて消す
                </button>
              )}
              {errors.length === 0 && warnings.length === 0 ? (
                <p className="text-sm text-emerald-700 dark:text-emerald-400">問題はありません。</p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-auto text-xs">
                  {[...errors, ...warnings].slice(0, 100).map((i, k) => (
                    <button
                      key={k}
                      onClick={() => i.target_code && (i.target_type === "node" || i.target_type === "pipe") && setSel({ type: i.target_type, id: i.target_code })}
                      className={`block w-full rounded px-2 py-1 text-left ${
                        i.severity === "error" ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200" : "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                      }`}
                    >
                      {i.severity === "error" ? "エラー：" : "注意："}
                      {i.message}
                    </button>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="保存（新しい版の下書き）">
              {diff && !isEmptyDiff(diff) ? (
                <ul className="mb-2 list-disc pl-5 text-xs text-zinc-600 dark:text-zinc-400">
                  {diff.addedNodes.length > 0 && <li>追加した機器 {diff.addedNodes.length} 件</li>}
                  {diff.addedPipes.length > 0 && <li>増えた配管 {diff.addedPipes.length} 本</li>}
                  {diff.removedNodes.length > 0 && <li className="text-red-700 dark:text-red-400">削除した機器 {diff.removedNodes.length} 件</li>}
                  {diff.removedPipes.length > 0 && <li className="text-red-700 dark:text-red-400">削除した配管 {diff.removedPipes.length} 本</li>}
                  {diff.changedNodes.length > 0 && <li>属性を変えた機器 {diff.changedNodes.length} 件</li>}
                  {diff.changedPipes.length > 0 && <li>属性・つながりを変えた配管 {diff.changedPipes.length} 本</li>}
                  {diff.moved > 0 && <li>位置・経由点の変更 {diff.moved} 箇所</li>}
                  {diff.areas > 0 && <li>区画枠の追加・変更・削除 {diff.areas} 件</li>}
                </ul>
              ) : (
                <p className="mb-2 text-xs text-zinc-500">まだ変更はありません。</p>
              )}
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="版のメモ（例：V-1234 追加）"
                className="mb-2 w-full rounded-lg border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
              />
              <button
                onClick={save}
                disabled={saving || !dirty || errors.length > 0}
                className="w-full rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
              >
                {saving ? "保存中…" : "下書きの版として保存"}
              </button>
              {errors.length > 0 && <p className="mt-1 text-xs text-red-600">エラーを直すと保存できます。</p>}
            </Panel>
          </aside>
        </div>
      </div>
    </main>
  );
}

// ───── 属性の欄 ─────

const NEEDS_NORMAL: NodeKind[] = ["valve", "drain", "gauge"];
const NEEDS_DIRECTION: NodeKind[] = ["check", "pump", "transferPump", "psv"];

function NodeForm({
  data,
  node,
  sheetNo,
  isNew,
  onChange,
  onRenamed,
  onError,
}: {
  data: DiagramData;
  node: NodeData;
  sheetNo: string;
  isNew: boolean;
  onChange: (d: DiagramData) => void;
  onRenamed: (from: string, to: string) => void;
  onError: (text: string) => void;
}) {
  const set = (patch: Partial<NodeData>) => onChange(updateNode(data, node.code, patch));
  const sym = data.symbols.find((s) => s.sheet_no === sheetNo && s.node_code === node.code);
  const neighbors = data.pipes.filter((p) => p.node_a === node.code || p.node_b === node.code).map((p) => (p.node_a === node.code ? p.node_b : p.node_a));
  const areas = [...new Set([...data.areas.map((a) => a.name), ...data.nodes.map((n) => n.area)])].filter(Boolean);
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-zinc-500">
        {KIND_LABEL[node.kind]}・つながる配管 {neighbors.length} 本{isNew ? "・このエディタで追加" : ""}
      </p>
      {isNew ? (
        <TextField
          label="機器番号"
          value={node.code}
          onCommit={(v) => {
            const r = renameNode(data, node.code, v);
            if (typeof r === "string") return onError(r);
            onChange(r);
            onRenamed(node.code, v.trim());
          }}
        />
      ) : (
        <Row label="機器番号">
          <span className="font-mono">{node.code}</span>
          <span className="ml-1 text-[11px] text-zinc-400">（既存の番号は変えません）</span>
        </Row>
      )}
      {isNew && (
        <Row label="種別">
          <select value={node.kind} onChange={(e) => set({ kind: e.target.value as NodeKind })} className={inputCls}>
            {(Object.keys(KIND_LABEL) as NodeKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Row>
      )}
      <TextField label="表示ラベル" value={node.label} onCommit={(v) => set({ label: v })} />
      <TextField label="名称" value={node.name} onCommit={(v) => set({ name: v })} />
      <TextField label="区画" value={node.area} list={areas} onCommit={(v) => set({ area: v })} />
      {NEEDS_NORMAL.includes(node.kind) && (
        <Row label="待機状態">
          <select value={node.normal ?? ""} onChange={(e) => set({ normal: (e.target.value || null) as NodeData["normal"] })} className={inputCls}>
            <option value="">（空欄）</option>
            <option value="open">開</option>
            <option value="close">閉</option>
          </select>
        </Row>
      )}
      {NEEDS_DIRECTION.includes(node.kind) && (
        <Row label="上流側">
          <select value={node.dir_from ?? ""} onChange={(e) => set({ dir_from: e.target.value || null })} className={inputCls}>
            <option value="">（空欄）</option>
            {neighbors.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Row>
      )}
      {(node.kind === "strainer" || node.kind === "filter" || node.kind === "pump" || node.kind === "transferPump") && (
        <NumField label="内容量(L)" value={node.volume_l} onCommit={(v) => set({ volume_l: v })} />
      )}
      {(node.kind === "pump" || node.kind === "transferPump") && <NumField label="定格流量(L/min)" value={node.rated_flow_lpm} onCommit={(v) => set({ rated_flow_lpm: v })} />}
      {node.kind === "tank" && <NumField label="タンク容量(kL)" value={node.capacity_kl} onCommit={(v) => set({ capacity_kl: v })} />}
      {node.kind === "psv" && <NumField label="設定圧力(MPa)" value={node.set_pressure_mpa} onCommit={(v) => set({ set_pressure_mpa: v })} />}
      {node.kind === "drain" && <NumField label="ドレン口径(A)" value={node.drain_size_a} onCommit={(v) => set({ drain_size_a: v })} />}
      <Row label="流体">
        <select value={node.fluid ?? ""} onChange={(e) => set({ fluid: (e.target.value || null) as Fluid | null })} className={inputCls}>
          <option value="">（空欄＝燃料）</option>
          {(Object.keys(FLUID_LABEL) as Fluid[]).map((k) => (
            <option key={k} value={k}>
              {FLUID_LABEL[k]}
            </option>
          ))}
        </select>
      </Row>
      <TextField label="系統" value={node.system ?? ""} onCommit={(v) => set({ system: v || null })} />
      <TextField label="備考" value={node.note ?? ""} onCommit={(v) => set({ note: v || null })} />
      {sym && (
        <div className="grid grid-cols-2 gap-2">
          <NumField label="X" value={sym.x} onCommit={(v) => v !== null && onChange(moveNode(data, sheetNo, node.code, v, sym.y))} />
          <NumField label="Y" value={sym.y} onCommit={(v) => v !== null && onChange(moveNode(data, sheetNo, node.code, sym.x, v))} />
        </div>
      )}
      {node.drain_route?.length ? <p className="text-[11px] text-zinc-500">抜取経路：{node.drain_route.join(" → ")}（Excel で編集）</p> : null}
    </div>
  );
}

function PipeForm({ data, pipe, sheetNo, onChange }: { data: DiagramData; pipe: PipeData; sheetNo: string; onChange: (d: DiagramData) => void }) {
  const set = (patch: Partial<PipeData>) => onChange(updatePipe(data, pipe.code, patch));
  const sheet = data.sheets.find((s) => s.sheet_no === sheetNo);
  const path = pipePath(data, sheetNo, pipe);
  let drawn = 0;
  for (let i = 0; i < path.length - 1; i++) drawn += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  const drawnM = sheet?.meters_per_unit ? drawn * sheet.meters_per_unit : null;
  const specs = data.specs.filter((s) => s.size_a === pipe.size_a);
  const via = viaOf(data, sheetNo, pipe.code);
  const spec = data.specs.find((s) => s.id === pipe.pipe_spec_id);
  const lengthM = pipe.length_m ?? drawnM;
  const volumeL = spec && lengthM !== null ? Math.PI * (spec.inner_diameter_mm / 2000) ** 2 * lengthM * 1000 : null;
  return (
    <div className="space-y-2 text-sm">
      <Row label="配管番号">
        <span className="font-mono">{pipe.code}</span>
      </Row>
      <p className="text-xs text-zinc-500">
        {pipe.node_a} → {pipe.node_b}・経由点 {via.length} 個
      </p>
      <TextField label="ライン番号" value={pipe.line_no ?? ""} onCommit={(v) => set({ line_no: v || null })} />
      <NumField label="呼び径(A)" value={pipe.size_a} onCommit={(v) => v !== null && set({ size_a: v })} />
      <Row label="配管仕様">
        <select value={pipe.pipe_spec_id ?? ""} onChange={(e) => set({ pipe_spec_id: e.target.value || null })} className={inputCls}>
          <option value="">（空欄＝呼び径の Sch40 相当）</option>
          {specs.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}（内径 {s.inner_diameter_mm}mm）
            </option>
          ))}
        </select>
      </Row>
      <NumField label="実長(m)" value={pipe.length_m} onCommit={(v) => set({ length_m: v, length_source: v === null ? null : pipe.length_source ?? "measured" })} />
      <Row label="実長の出典">
        <select
          value={pipe.length_source ?? ""}
          onChange={(e) => set({ length_source: (e.target.value || null) as PipeData["length_source"] })}
          className={inputCls}
        >
          <option value="">（空欄）</option>
          <option value="measured">実測</option>
          <option value="isometric">アイソメ図</option>
          <option value="cad">CAD</option>
          <option value="drawing_estimate">図面から概算</option>
        </select>
      </Row>
      <p className="text-[11px] text-zinc-500">
        図面上の長さ：{drawnM !== null ? `約 ${drawnM.toFixed(1)} m` : "縮尺が無いため計算できません"}
        {pipe.length_m === null && drawnM !== null ? "（実長が空欄なので、この長さで容量を計算します）" : ""}
        {volumeL !== null ? `・容量 約 ${volumeL.toFixed(1)} L` : ""}
      </p>
      <Row label="流体">
        <select value={pipe.fluid ?? ""} onChange={(e) => set({ fluid: (e.target.value || null) as Fluid | null })} className={inputCls}>
          <option value="">（空欄＝両端の機器から）</option>
          {(Object.keys(FLUID_LABEL) as Fluid[]).map((k) => (
            <option key={k} value={k}>
              {FLUID_LABEL[k]}
            </option>
          ))}
        </select>
      </Row>
      <TextField label="備考" value={pipe.note ?? ""} onCommit={(v) => set({ note: v || null })} />
      {via.length > 0 && (
        <button onClick={() => onChange(setVia(data, sheetNo, pipe.code, []))} className="text-xs text-sky-700 underline dark:text-sky-400">
          経由点をすべて消す（両端を直線で結ぶ）
        </button>
      )}
    </div>
  );
}

const inputCls = "w-full rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[96px_1fr] items-center gap-2">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/** 文字の欄：入力を終えたとき（欄から出た・Enter）に確定する */
function TextField({ label, value, onCommit, list }: { label: string; value: string; onCommit: (v: string) => void; list?: string[] }) {
  const [v, setV] = useState(value);
  const listId = list ? `list-${label}` : undefined;
  const done = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <Row label={label}>
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && done()} list={listId} className={inputCls} />
      {list && (
        <datalist id={listId}>
          {list.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      )}
    </Row>
  );
}

function NumField({ label, value, onCommit }: { label: string; value: number | null; onCommit: (v: number | null) => void }) {
  const [v, setV] = useState(value === null ? "" : String(value));
  const done = () => {
    const t = v.trim();
    const n = t === "" ? null : Number(t);
    if (n !== null && !Number.isFinite(n)) return setV(value === null ? "" : String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <Row label={label}>
      <input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && done()} className={inputCls} />
    </Row>
  );
}

/** 区画枠の欄：選んだ枠の名前・位置・大きさ、枠の無い区画への枠づくり、新しい区画 */
function AreaPanel({
  data,
  sheetNo,
  selected,
  onSelect,
  onChange,
  onNew,
  onError,
}: {
  data: DiagramData;
  sheetNo: string;
  selected: string | null;
  onSelect: (name: string | null) => void;
  onChange: (d: DiagramData) => void;
  onNew: (name: string) => void;
  onError: (text: string) => void;
}) {
  const frames = framesOf(data, sheetNo);
  const area = frames.find((a) => a.name === selected);
  const unframed = unframedAreas(data, sheetNo);
  const [alsoNodes, setAlsoNodes] = useState(true);
  const [newName, setNewName] = useState("");
  const nodeCount = (name: string) => data.nodes.filter((n) => n.area === name).length;
  const box = area ? { x: area.x!, y: area.y!, w: area.w!, h: area.h! } : null;
  return (
    <div className="space-y-3 text-sm">
      <Row label="枠">
        <select value={selected ?? ""} onChange={(e) => onSelect(e.target.value || null)} className={inputCls}>
          <option value="">（選んでください）</option>
          {frames.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
      </Row>
      {area && box && (
        <div className="space-y-2 rounded-lg border border-violet-200 p-2 dark:border-violet-900">
          <TextField
            label="区画名"
            value={area.name}
            onCommit={(v) => {
              const r = renameArea(data, area.name, v, alsoNodes);
              if (typeof r === "string") return onError(r);
              onChange(r);
              onSelect(v.trim());
            }}
          />
          <label className="flex items-start gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={alsoNodes} onChange={(e) => setAlsoNodes(e.target.checked)} className="mt-0.5" />
            名前を変えるとき、区画欄が同じ名前の機器（{nodeCount(area.name)} 件）の区画名も変える（運用停止範囲・消火試験の判定に使われます）
          </label>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="X" value={box.x} onCommit={(v) => v !== null && onChange(setAreaBox(data, sheetNo, area.name, { ...box, x: v }))} />
            <NumField label="Y" value={box.y} onCommit={(v) => v !== null && onChange(setAreaBox(data, sheetNo, area.name, { ...box, y: v }))} />
            <NumField label="幅" value={box.w} onCommit={(v) => v !== null && onChange(setAreaBox(data, sheetNo, area.name, { ...box, w: v }))} />
            <NumField label="高さ" value={box.h} onCommit={(v) => v !== null && onChange(setAreaBox(data, sheetNo, area.name, { ...box, h: v }))} />
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              onClick={() => {
                const b = fitBox(data, sheetNo, area.name);
                if (!b) return onError(`区画「${area.name}」の機器がこのシートにありません`);
                onChange(setAreaBox(data, sheetNo, area.name, b));
              }}
              className="rounded border border-zinc-300 px-2 py-0.5 dark:border-zinc-700"
            >
              機器に合わせる
            </button>
            <button
              onClick={() => {
                if (!confirm(`区画「${area.name}」の枠を消しますか？\n機器の区画欄はそのまま残ります（図面に枠が出なくなるだけです）。`)) return;
                onChange(deleteArea(data, area.name));
                onSelect(null);
              }}
              className="rounded border border-red-300 px-2 py-0.5 text-red-700 dark:border-red-900 dark:text-red-400"
            >
              枠を消す
            </button>
          </div>
        </div>
      )}
      {unframed.length > 0 && (
        <div>
          <p className="text-xs text-zinc-500">枠の無い区画（機器の区画欄にだけある名前）</p>
          <div className="mt-1 space-y-1">
            {unframed.map((u) => (
              <div key={u.name} className="flex items-center justify-between gap-2 text-xs">
                <span>
                  {u.name}
                  <span className="text-zinc-400">（機器 {u.count} 件）</span>
                </span>
                <button
                  onClick={() => {
                    const b = fitBox(data, sheetNo, u.name);
                    if (!b) return onError(`区画「${u.name}」の機器がこのシートにありません`);
                    onChange(setAreaBox(data, sheetNo, u.name, b));
                    onSelect(u.name);
                  }}
                  className="shrink-0 rounded border border-violet-400 px-2 py-0.5 text-violet-700 dark:text-violet-300"
                >
                  機器に合わせて枠を作る
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div>
        <p className="text-xs text-zinc-500">新しい区画の枠</p>
        <div className="mt-1 flex gap-1">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="区画名" className={inputCls} />
          <button
            onClick={() => {
              const n = newName.trim();
              if (!n) return onError("区画名を入れてください");
              if (data.areas.some((a) => a.name === n)) return onError(`区画「${n}」はすでにあります`);
              onNew(n);
              setNewName("");
            }}
            className="shrink-0 rounded border border-zinc-300 px-2 text-xs dark:border-zinc-700"
          >
            置く
          </button>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">「置く」のあと、図面の空き場所をクリックした位置に枠を作ります。機器をこの区画に入れるときは、機器の区画欄を変えてください。</p>
      </div>
    </div>
  );
}

function ToolButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded border px-2 py-0.5 ${active ? "border-cyan-600 bg-cyan-600 font-semibold text-white" : "border-zinc-300 dark:border-zinc-700"}`}
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

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-6 text-sm text-zinc-600 dark:bg-black dark:text-zinc-400">
      <div className="mx-auto max-w-3xl space-y-2">
        <Link href="/piping/data" className="text-zinc-500 underline">
          ← ④ 系統図データ管理
        </Link>
        <p>{children}</p>
      </div>
    </main>
  );
}
