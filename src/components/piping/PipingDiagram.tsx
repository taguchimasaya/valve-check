"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { pipePoints, type Graph } from "@/lib/piping/graph";
import type { PNode, ValveState } from "@/lib/piping/types";

// 配管系統図（SVG）。図面データ（Graph）と、各画面が重ねたい表示（レイヤー・マーク）を受け取って描く。

export type PipeLayer = {
  key: string;
  pipeIds: Iterable<string>;
  color: string;
  width?: number;
  /** 点滅（点検対象ラインなど） */
  blink?: boolean;
  /** 流れ方向の破線アニメーション（運用ライン） */
  flow?: boolean;
  opacity?: number;
};

export type NodeMark =
  | "pending" // 操作待ち（点滅）
  | "done" // 現場で操作済み（点灯）
  | "confirmed" // 制御室確認済み
  | "ng"
  | "boundary" // 遮断弁（計画）
  | "internal" // 範囲内弁（計画）
  | "drain" // 抜取に使うドレン
  | "gauge" // 圧力計取付推奨
  | "vent" // 開けば液封を回避できる弁
  | "selected" // 選択中（対象機器）
  | "manual" // 制御室で手動変更した弁
  | "fill"; // 充填に使う弁

const MARK_STYLE: Record<NodeMark, { color: string; blink?: boolean; fill?: string; width?: number }> = {
  pending: { color: "#f59e0b", blink: true, width: 3 },
  done: { color: "#22c55e", fill: "rgba(34,197,94,0.35)", width: 3 },
  confirmed: { color: "#2563eb", fill: "rgba(37,99,235,0.3)", width: 3 },
  ng: { color: "#dc2626", fill: "rgba(220,38,38,0.35)", width: 3, blink: true },
  boundary: { color: "#dc2626", width: 2.5 },
  internal: { color: "#16a34a", width: 2.5 },
  drain: { color: "#0284c7", width: 2.5 },
  gauge: { color: "#a855f7", width: 2.5 },
  vent: { color: "#f59e0b", width: 2 },
  selected: { color: "#06b6d4", fill: "rgba(6,182,212,0.25)", width: 3 },
  manual: { color: "#7c3aed", fill: "rgba(124,58,237,0.15)", width: 2.5 },
  fill: { color: "#0d9488", width: 2.5 },
};

const CSS = `
@keyframes piping-blink { 0%,100% { opacity: 1 } 50% { opacity: 0.15 } }
.piping-blink { animation: piping-blink 1s ease-in-out infinite; }
@keyframes piping-flow { to { stroke-dashoffset: -24; } }
.piping-flow { stroke-dasharray: 14 10; animation: piping-flow 0.8s linear infinite; }
.piping-hit { cursor: pointer; }
.piping-hit:hover .piping-hover { stroke: #06b6d4; stroke-opacity: 0.5; }
`;

type Props = {
  graph: Graph;
  valveState: Record<string, ValveState>;
  layers?: PipeLayer[];
  marks?: Record<string, NodeMark>;
  onNodeClick?: (id: string) => void;
  onPipeClick?: (id: string) => void;
  /** クリックを受け付けるノード種別（省略時はクリック不可） */
  clickableKinds?: PNode["kind"][];
  height?: string;
  showLabels?: boolean;
  toolbar?: ReactNode;
};

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 6;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** 拡大縮小の基準点：図面全体に対する位置（割合）と、それを表示枠内のどこに置くか（px） */
type ZoomAnchor = { fx: number; fy: number; mx: number; my: number };

function pipeWidth(sizeA: number) {
  return 1.4 + sizeA / 90;
}

function pts(points: [number, number][]) {
  return points.map((p) => p.join(",")).join(" ");
}

export default function PipingDiagram({
  graph,
  valveState,
  layers = [],
  marks = {},
  onNodeClick,
  onPipeClick,
  clickableKinds = [],
  height = "70vh",
  showLabels = true,
  toolbar,
}: Props) {
  const f = graph.facility;
  const [zoom, setZoom] = useState(1);
  // 図面はブラウザ側だけで描く（SSRとの差分による hydration エラーを避ける）
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const pipeGeom = useMemo(
    () => new Map(f.pipes.map((p) => [p.id, pipePoints(graph, p)])),
    [f, graph]
  );

  // バルブ・ポンプの向き（つながっている配管の方向から決める）
  const orient = useMemo(() => {
    const m = new Map<string, { horizontal: boolean; downstream?: [number, number] }>();
    f.nodes.forEach((n) => {
      const adj = graph.adj.get(n.id) ?? [];
      if (!adj.length) return;
      const first = pipeGeom.get(adj[0].pipe.id)!;
      const near = adj[0].pipe.a === n.id ? first[1] : first[first.length - 2];
      const horizontal = Math.abs(near[0] - n.x) >= Math.abs(near[1] - n.y);
      let downstream: [number, number] | undefined;
      if (n.dirFrom) {
        const down = adj.find((a) => a.other !== n.dirFrom);
        if (down) {
          const g2 = pipeGeom.get(down.pipe.id)!;
          downstream = down.pipe.a === n.id ? g2[1] : g2[g2.length - 2];
        }
      }
      m.set(n.id, { horizontal, downstream });
    });
    return m;
  }, [f, graph, pipeGeom]);

  const clickable = new Set(clickableKinds);

  // ───── 拡大縮小（ボタン・マウスホイール・ピンチ） ─────
  // 拡大後も、指やカーソルの下にあった図面の位置が同じ場所に来るようスクロールを合わせる
  const zoomRef = useRef(1);
  const anchorRef = useRef<ZoomAnchor | null>(null);

  function anchorAt(mx: number, my: number): ZoomAnchor | null {
    const el = scrollRef.current;
    if (!el || !el.scrollWidth) return null;
    return { fx: (el.scrollLeft + mx) / el.scrollWidth, fy: (el.scrollTop + my) / el.scrollHeight, mx, my };
  }

  function applyZoom(next: number, anchor: ZoomAnchor | null) {
    const z = clampZoom(next);
    if (z === zoomRef.current) return;
    anchorRef.current = anchor;
    zoomRef.current = z;
    setZoom(z);
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    el.scrollLeft = a.fx * el.scrollWidth - a.mx;
    el.scrollTop = a.fy * el.scrollHeight - a.my;
    anchorRef.current = null;
  }, [zoom]);

  function zoomBy(factor: number) {
    const el = scrollRef.current;
    applyZoom(zoomRef.current * factor, el ? anchorAt(el.clientWidth / 2, el.clientHeight / 2) : null);
  }

  function resetZoom() {
    anchorRef.current = { fx: 0, fy: 0, mx: 0, my: 0 };
    zoomRef.current = 1;
    setZoom(1);
  }

  // ホイール・ピンチはページ自体のスクロール／拡大を止める必要があるため、passive でないリスナーで受ける
  const applyZoomRef = useRef(applyZoom);
  const anchorAtRef = useRef(anchorAt);
  useEffect(() => {
    applyZoomRef.current = applyZoom;
    anchorAtRef.current = anchorAt;
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const local = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      return [x - r.left, y - r.top] as const;
    };

    let wheelFactor = 1;
    let wheelPos: readonly [number, number] = [0, 0];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // トラックパッドのピンチ（ctrlKey付き）は変化量が小さいので感度を上げる
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      wheelFactor *= Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015));
      wheelPos = local(e.clientX, e.clientY);
      // 連続するホイール入力はまとめて1回の拡大縮小にする（約60fps）
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const [mx, my] = wheelPos;
        applyZoomRef.current(zoomRef.current * wheelFactor, anchorAtRef.current(mx, my));
        wheelFactor = 1;
      }, 16);
    };

    let pinch: { dist: number; zoom: number; fx: number; fy: number } | null = null;
    const touchInfo = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      const [mx, my] = local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), mx, my };
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const t = touchInfo(e);
      const a = anchorAtRef.current(t.mx, t.my);
      if (!a || !t.dist) return;
      pinch = { dist: t.dist, zoom: zoomRef.current, fx: a.fx, fy: a.fy };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const t = touchInfo(e);
      // 2本指の中点を動かすと、拡大しながら移動もできる
      applyZoomRef.current(pinch.zoom * (t.dist / pinch.dist), { fx: pinch.fx, fy: pinch.fy, mx: t.mx, my: t.my });
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    // iOS Safari のページ拡大（gesture イベント）を止める
    const stopGesture = (e: Event) => e.preventDefault();

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("gesturestart", stopGesture);
    el.addEventListener("gesturechange", stopGesture);
    return () => {
      if (timer) clearTimeout(timer);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("gesturestart", stopGesture);
      el.removeEventListener("gesturechange", stopGesture);
    };
  }, []);

  function renderNode(n: PNode) {
    const o = orient.get(n.id);
    const st = valveState[n.id];
    const label = showLabels ? n.label : "";
    const textCls = "fill-zinc-700 dark:fill-zinc-300";
    switch (n.kind) {
      case "junction":
        return (graph.adj.get(n.id)?.length ?? 0) >= 3 ? (
          <circle cx={n.x} cy={n.y} r={2.6} className="fill-zinc-500" />
        ) : null;
      case "valve": {
        const s = 8;
        const fill = st === "open" ? "#10b981" : "#ef4444";
        const shape = o?.horizontal
          ? `${n.x - s},${n.y - s * 0.7} ${n.x + s},${n.y + s * 0.7} ${n.x + s},${n.y - s * 0.7} ${n.x - s},${n.y + s * 0.7}`
          : `${n.x - s * 0.7},${n.y - s} ${n.x + s * 0.7},${n.y + s} ${n.x - s * 0.7},${n.y + s} ${n.x + s * 0.7},${n.y - s}`;
        return (
          <g>
            <polygon points={shape} fill={fill} stroke="#27272a" strokeWidth={1} strokeLinejoin="round" />
            {label && (
              <text
                x={o?.horizontal ? n.x : n.x + 10}
                y={o?.horizontal ? n.y - 11 : n.y + 3}
                textAnchor={o?.horizontal ? "middle" : "start"}
                fontSize={8.5}
                className={textCls}
              >
                {label.replace(/^V-/, "")}
              </text>
            )}
          </g>
        );
      }
      case "check": {
        const d = o?.downstream ?? [n.x + 1, n.y];
        const ang = (Math.atan2(d[1] - n.y, d[0] - n.x) * 180) / Math.PI;
        return (
          <g transform={`rotate(${ang} ${n.x} ${n.y})`}>
            <polygon
              points={`${n.x - 7},${n.y - 6} ${n.x + 5},${n.y} ${n.x - 7},${n.y + 6}`}
              className="fill-white dark:fill-zinc-900"
              stroke="#52525b"
              strokeWidth={1.3}
            />
            <line x1={n.x + 6} y1={n.y - 7} x2={n.x + 6} y2={n.y + 7} stroke="#52525b" strokeWidth={1.8} />
          </g>
        );
      }
      case "pump":
      case "transferPump": {
        const d = o?.downstream ?? [n.x + 1, n.y];
        const ang = (Math.atan2(d[1] - n.y, d[0] - n.x) * 180) / Math.PI;
        return (
          <g>
            <circle cx={n.x} cy={n.y} r={15} className="fill-white dark:fill-zinc-900" stroke="#1d4ed8" strokeWidth={2} />
            <polygon
              transform={`rotate(${ang} ${n.x} ${n.y})`}
              points={`${n.x - 7},${n.y - 8} ${n.x + 9},${n.y} ${n.x - 7},${n.y + 8}`}
              fill="#1d4ed8"
            />
            <text x={n.x} y={n.y + 27} textAnchor="middle" fontSize={10} fontWeight={600} className={textCls}>
              {n.label}
            </text>
          </g>
        );
      }
      case "strainer":
        return (
          <g>
            <rect x={n.x - 13} y={n.y - 10} width={26} height={20} rx={3} className="fill-white dark:fill-zinc-900" stroke="#0f766e" strokeWidth={1.8} />
            <path d={`M${n.x - 8},${n.y - 6} L${n.x + 8},${n.y + 6} M${n.x - 8},${n.y + 6} L${n.x + 8},${n.y - 6}`} stroke="#0f766e" strokeWidth={1} />
            {showLabels && (
              <text x={n.x} y={n.y - 14} textAnchor="middle" fontSize={8.5} className={textCls}>
                {n.label}
              </text>
            )}
          </g>
        );
      case "filter":
        return (
          <g>
            <rect x={n.x - 15} y={n.y - 20} width={30} height={40} rx={10} className="fill-white dark:fill-zinc-900" stroke="#7c3aed" strokeWidth={1.8} />
            <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#7c3aed">
              F
            </text>
            {showLabels && (
              <text x={n.x} y={n.y - 24} textAnchor="middle" fontSize={8.5} className={textCls}>
                {n.label}
              </text>
            )}
          </g>
        );
      case "psv":
        return (
          <g>
            <rect x={n.x - 7} y={n.y - 9} width={14} height={18} className="fill-amber-100 dark:fill-amber-950" stroke="#b45309" strokeWidth={1.5} />
            <path d={`M${n.x - 4},${n.y - 5} l8,3 l-8,3 l8,3`} stroke="#b45309" fill="none" strokeWidth={1} />
            {showLabels && !n.compact && (
              <text x={n.x + 10} y={n.y + 3} fontSize={8} fill="#b45309" fontWeight={600}>
                {n.label}
              </text>
            )}
          </g>
        );
      case "drain": {
        const open = st === "open";
        return (
          <g>
            <polygon
              points={`${n.x - 6},${n.y - 5} ${n.x + 6},${n.y - 5} ${n.x},${n.y + 5}`}
              fill={open ? "#0284c7" : "white"}
              stroke="#0284c7"
              strokeWidth={1.4}
            />
            {n.drainPumpLpm ? (
              <circle cx={n.x + 9} cy={n.y} r={3.5} fill="#0284c7">
                <title>抜取ポンプ付</title>
              </circle>
            ) : null}
            {showLabels && (
              <text x={n.x + (n.drainPumpLpm ? 15 : 8)} y={n.y + 3} fontSize={7.5} fill="#0369a1">
                {n.label}
              </text>
            )}
          </g>
        );
      }
      case "gauge":
        return (
          <g>
            <circle cx={n.x} cy={n.y} r={7} fill={st === "open" ? "#f3e8ff" : "white"} stroke="#7e22ce" strokeWidth={1.4} />
            <line x1={n.x} y1={n.y} x2={n.x + 4} y2={n.y - 4} stroke="#7e22ce" strokeWidth={1.3} />
            {showLabels && (
              <text x={n.x + 10} y={n.y + 3} fontSize={7.5} fill="#7e22ce">
                {n.label}
              </text>
            )}
          </g>
        );
      case "tank":
        if (n.recovery) {
          return (
            <g>
              <rect x={n.x - 28} y={n.y - 18} width={56} height={36} rx={5} className="fill-amber-50 dark:fill-amber-950" stroke="#b45309" strokeWidth={1.6} />
              <text x={n.x} y={n.y - 1} textAnchor="middle" fontSize={9} fontWeight={700} fill="#b45309">
                {n.label}
              </text>
              <text x={n.x} y={n.y + 11} textAnchor="middle" fontSize={7.5} fill="#b45309">
                回収タンク
              </text>
            </g>
          );
        }
        return (
          <g>
            <rect x={n.x - 55} y={n.y - 45} width={110} height={90} rx={8} className="fill-sky-50 dark:fill-sky-950" stroke="#0369a1" strokeWidth={2} />
            <text x={n.x} y={n.y - 2} textAnchor="middle" fontSize={16} fontWeight={700} fill="#0369a1">
              {n.label}
            </text>
            <text x={n.x} y={n.y + 16} textAnchor="middle" fontSize={9.5} className={textCls}>
              {String(n.capacityKL ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")} kL
            </text>
          </g>
        );
      case "source":
      case "sink": {
        const w = 70;
        const x0 = n.kind === "source" ? n.x - 30 : n.x - 10;
        return (
          <g>
            <polygon
              points={`${x0},${n.y - 16} ${x0 + w - 14},${n.y - 16} ${x0 + w},${n.y} ${x0 + w - 14},${n.y + 16} ${x0},${n.y + 16}`}
              className="fill-zinc-100 dark:fill-zinc-800"
              stroke="#52525b"
              strokeWidth={1.5}
            />
            <text x={x0 + w / 2 - 6} y={n.y + 4} textAnchor="middle" fontSize={10} fontWeight={600} className={textCls}>
              {n.label}
            </text>
          </g>
        );
      }
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <button onClick={() => zoomBy(1.25)} className="rounded border border-zinc-300 px-2 py-0.5 dark:border-zinc-700" aria-label="拡大">
          ＋
        </button>
        <button onClick={() => zoomBy(0.8)} className="rounded border border-zinc-300 px-2 py-0.5 dark:border-zinc-700" aria-label="縮小">
          －
        </button>
        <button onClick={resetZoom} className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700">
          全体
        </button>
        <span className="text-xs text-zinc-500">{Math.round(zoom * 100)}%</span>
        <span className="hidden text-[11px] text-zinc-400 sm:inline">ホイール／ピンチで拡大縮小</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>
      </div>
      <div ref={scrollRef} className="overflow-auto overscroll-contain" style={{ height, touchAction: "pan-x pan-y" }}>
        {mounted && (
        <svg
          viewBox={`0 0 ${f.width} ${f.height}`}
          style={{ width: `${zoom * 100}%`, minWidth: zoom * 1100 }}
          className="block select-none"
        >
          <style>{CSS}</style>
          {f.areas.map((a) => (
            <g key={a.label}>
              <rect x={a.x} y={a.y} width={a.w} height={a.h} rx={12} fill="none" stroke="#a1a1aa" strokeDasharray="6 5" strokeWidth={1} />
              <text x={a.x + 10} y={a.y + 16} fontSize={13} fontWeight={600} className="fill-zinc-500 dark:fill-zinc-400">
                {a.label}
              </text>
            </g>
          ))}

          {/* 配管（ベース） */}
          {f.pipes.map((p) => (
            <polyline
              key={p.id}
              points={pts(pipeGeom.get(p.id)!)}
              fill="none"
              stroke="#71717a"
              strokeWidth={pipeWidth(p.sizeA)}
              strokeLinejoin="round"
            />
          ))}

          {/* 重ね表示（運用ライン・点検範囲など） */}
          {layers.map((l) => (
            <g key={l.key} className={l.blink ? "piping-blink" : undefined} opacity={l.opacity ?? 1}>
              {[...l.pipeIds].map((pid) => {
                const geo = pipeGeom.get(pid);
                if (!geo) return null;
                const p = graph.pipeById.get(pid)!;
                return (
                  <polyline
                    key={pid}
                    points={pts(geo)}
                    fill="none"
                    stroke={l.color}
                    strokeWidth={l.width ?? pipeWidth(p.sizeA) + 5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    className={l.flow ? "piping-flow" : undefined}
                  />
                );
              })}
            </g>
          ))}

          {/* 配管クリック用の当たり判定 */}
          {onPipeClick &&
            f.pipes.map((p) => (
              <g key={`hit-${p.id}`} className="piping-hit" onClick={() => onPipeClick(p.id)}>
                <polyline points={pts(pipeGeom.get(p.id)!)} fill="none" stroke="transparent" strokeWidth={14} className="piping-hover" />
              </g>
            ))}

          {/* マーク（リング） */}
          {Object.entries(marks).map(([id, mark]) => {
            const n = graph.nodeById.get(id);
            if (!n) return null;
            const s = MARK_STYLE[mark];
            const r = n.kind === "tank" ? (n.recovery ? 34 : 62) : n.kind === "filter" ? 25 : n.kind.includes("ump") ? 20 : 14;
            return (
              <circle
                key={`mark-${id}`}
                cx={n.x}
                cy={n.y}
                r={r}
                fill={s.fill ?? "none"}
                stroke={s.color}
                strokeWidth={s.width ?? 2}
                className={s.blink ? "piping-blink" : undefined}
                style={mark === "done" || mark === "confirmed" ? { filter: `drop-shadow(0 0 5px ${s.color})` } : undefined}
              />
            );
          })}

          {/* ノード */}
          {f.nodes.map((n) => {
            const isClickable = !!onNodeClick && clickable.has(n.kind);
            return (
              <g
                key={n.id}
                onClick={isClickable ? () => onNodeClick!(n.id) : undefined}
                style={isClickable ? { cursor: "pointer" } : undefined}
              >
                {isClickable && <circle cx={n.x} cy={n.y} r={n.kind === "tank" && !n.recovery ? 50 : 14} fill="transparent" />}
                {renderNode(n)}
                <title>
                  {n.name}
                  {valveState[n.id] ? `（${valveState[n.id] === "open" ? "開" : "閉"}）` : ""}
                </title>
              </g>
            );
          })}

          {/* 済みマークのチェック */}
          {Object.entries(marks).map(([id, mark]) => {
            if (mark !== "done" && mark !== "confirmed") return null;
            const n = graph.nodeById.get(id);
            if (!n) return null;
            return (
              <g key={`chk-${id}`}>
                <circle cx={n.x + 12} cy={n.y - 12} r={6} fill={MARK_STYLE[mark].color} />
                <path d={`M${n.x + 9},${n.y - 12} l2,2.5 l4,-5`} stroke="white" strokeWidth={1.6} fill="none" />
              </g>
            );
          })}
        </svg>
        )}
      </div>
    </div>
  );
}

export function DiagramLegend({ items }: { items: { color: string; label: string; kind?: "line" | "ring" | "blink" }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          {i.kind === "ring" || i.kind === "blink" ? (
            <span
              className={`inline-block h-3 w-3 rounded-full border-2 ${i.kind === "blink" ? "animate-pulse" : ""}`}
              style={{ borderColor: i.color }}
            />
          ) : (
            <span className="inline-block h-1.5 w-5 rounded" style={{ background: i.color }} />
          )}
          {i.label}
        </span>
      ))}
    </div>
  );
}
