"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getFacility } from "./facility";
import { buildGraph, type Graph } from "./graph";
import type { Facility } from "./types";
import { dispatch, fetchStore, type PipingStore, type StoreAction } from "./store";
import type { DiagramPayload, DiagramSource } from "./diagramDb";
import { authFetch } from "../auth";

// ───── 拠点（施設）の選択：端末ごとに記憶する ─────
export const DEFAULT_FACILITY = "virtual-airport";
const FACILITY_KEY = "piping.facility";
let facilityId: string | null = null;

function currentFacilityId(): string {
  if (typeof window === "undefined") return DEFAULT_FACILITY;
  if (facilityId === null) {
    try {
      facilityId = window.localStorage.getItem(FACILITY_KEY) || DEFAULT_FACILITY;
    } catch {
      facilityId = DEFAULT_FACILITY;
    }
  }
  return facilityId;
}

/** 拠点を切り替える（全画面のデータを入れ替えるため、ページを読み込み直す） */
export function selectFacility(id: string) {
  try {
    window.localStorage.setItem(FACILITY_KEY, id);
  } catch {
    // 記憶できない環境でも、この画面の間は切り替える
  }
  facilityId = id;
  window.location.reload();
}

/** 選択中の拠点ID */
export function useFacilityId(): string {
  return useSyncExternalStore(
    () => () => {},
    currentFacilityId,
    () => DEFAULT_FACILITY
  );
}

export type FacilityItem = { id: string; name: string; activeVersionNo: number | null };
let facilitiesCache: Promise<FacilityItem[]> | null = null;

/** 拠点の一覧（DBの施設。読めなければ仮想施設だけ） */
export function useFacilities(): FacilityItem[] | null {
  const [list, setList] = useState<FacilityItem[] | null>(null);
  useEffect(() => {
    facilitiesCache ??= authFetch("/api/piping/facilities", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { facilities: [] }))
      .then((j: { facilities: FacilityItem[] }) => j.facilities)
      .catch(() => []);
    let alive = true;
    facilitiesCache.then((l) => {
      if (alive) setList(l);
    });
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

// ───── 系統図：選択中の拠点の「使用中」の版を DB から読み込む ─────
// 読み込むまでは、仮想施設ならプログラム内の施設（サンプルと同じ内容）、ほかの拠点なら空の図面で表示する。
const BUILTIN: DiagramSource = { source: "builtin", facilityId: DEFAULT_FACILITY, versionId: null, versionNo: null };
let diagram: { graph: Graph; info: DiagramSource } | null = null;
let serverDiagram: { graph: Graph; info: DiagramSource } | null = null;
let diagramRequested = false;
const diagramListeners = new Set<() => void>();

const emptyFacility = (name: string): Facility => ({ name, width: 1200, height: 700, metersPerPx: 0, nodes: [], pipes: [], areas: [] });

function builtinDiagram() {
  serverDiagram ??= { graph: buildGraph(getFacility()), info: BUILTIN };
  return serverDiagram;
}

function currentDiagram() {
  if (!diagram) {
    const id = currentFacilityId();
    diagram =
      id === DEFAULT_FACILITY
        ? builtinDiagram()
        : {
            graph: buildGraph(emptyFacility(id)),
            info: { source: "none", facilityId: id, versionId: null, versionNo: null, notice: "読み込み中…" },
          };
  }
  return diagram;
}

function loadDiagram() {
  if (diagramRequested || typeof window === "undefined") return;
  diagramRequested = true;
  const id = currentFacilityId();
  authFetch(`/api/piping/diagram?facility=${encodeURIComponent(id)}`, { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) throw new Error((await res.text()) || "系統図を読み込めませんでした");
      return (await res.json()) as DiagramPayload;
    })
    .then(({ facility, ...info }) => {
      diagram = { graph: info.source === "builtin" ? currentDiagram().graph : buildGraph(facility), info };
      diagramListeners.forEach((l) => l());
    })
    .catch((e) => {
      const cur = currentDiagram();
      diagram = { graph: cur.graph, info: { ...cur.info, notice: e instanceof Error ? e.message : String(e) } };
      diagramListeners.forEach((l) => l());
    });
}

function subscribeDiagram(cb: () => void) {
  diagramListeners.add(cb);
  loadDiagram();
  return () => {
    diagramListeners.delete(cb);
  };
}

/** 系統図（全画面で共通） */
export function useGraph(): Graph {
  return useSyncExternalStore(subscribeDiagram, () => currentDiagram().graph, () => builtinDiagram().graph);
}

/** 表示中の系統図がどこから来たか（DBの版／プログラム内の仮想施設／未登録） */
export function useDiagramInfo(): DiagramSource {
  return useSyncExternalStore(subscribeDiagram, () => currentDiagram().info, () => builtinDiagram().info);
}

/** ローカルストアを定期取得する（現場・制御室間の同期用。ローカルdevサーバー宛てのみ） */
export function usePipingStore(intervalMs = 1500) {
  const [store, setStore] = useState<PipingStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(-1);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchStore(currentFacilityId());
      if (s.version !== versionRef.current) {
        versionRef.current = s.version;
        setStore(s);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = intervalMs ? setInterval(refresh, intervalMs) : undefined;
    return () => {
      clearTimeout(first);
      if (t) clearInterval(t);
    };
  }, [refresh, intervalMs]);

  const act = useCallback(async (action: StoreAction) => {
    const s = await dispatch(currentFacilityId(), action);
    versionRef.current = s.version;
    setStore(s);
    return s;
  }, []);

  return { store, error, act, refresh };
}

// ───── localStorage の値（端末ごとの選択状態の記憶用） ─────
const LS_EVENT = "piping-local-storage";

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function useLocalValue(key: string): [string | null, (v: string | null) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      window.addEventListener(LS_EVENT, cb);
      window.addEventListener("storage", cb);
      return () => {
        window.removeEventListener(LS_EVENT, cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => readLocal(key),
    () => null
  );
  const set = useCallback(
    (v: string | null) => {
      try {
        if (v === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, v);
      } catch {
        // 保存できない環境では記憶しない
      }
      window.dispatchEvent(new Event(LS_EVENT));
    },
    [key]
  );
  return [value, set];
}
