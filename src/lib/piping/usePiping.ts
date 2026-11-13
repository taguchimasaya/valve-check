"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getFacility } from "./facility";
import { buildGraph, type Graph } from "./graph";
import { dispatch, fetchStore, type PipingStore, type StoreAction } from "./store";
import type { DiagramPayload, DiagramSource } from "./diagramDb";

// 系統図は DB（使用中の版）から読み込む。読み込むまでは、プログラム内の仮想施設（サンプルと同じ内容）で表示する。
const BUILTIN: DiagramSource = { source: "builtin", facilityId: "virtual-airport", versionId: null, versionNo: null };
let diagram: { graph: Graph; info: DiagramSource } | null = null;
let diagramRequested = false;
const diagramListeners = new Set<() => void>();

function currentDiagram() {
  if (!diagram) diagram = { graph: buildGraph(getFacility()), info: BUILTIN };
  return diagram;
}

function loadDiagram() {
  if (diagramRequested) return;
  diagramRequested = true;
  fetch("/api/piping/diagram", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) throw new Error((await res.text()) || "系統図を読み込めませんでした");
      return (await res.json()) as DiagramPayload;
    })
    .then(({ facility, ...info }) => {
      diagram = { graph: info.source === "db" ? buildGraph(facility) : currentDiagram().graph, info };
      diagramListeners.forEach((l) => l());
    })
    .catch((e) => {
      diagram = { graph: currentDiagram().graph, info: { ...BUILTIN, notice: e instanceof Error ? e.message : String(e) } };
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
  return useSyncExternalStore(subscribeDiagram, () => currentDiagram().graph, () => currentDiagram().graph);
}

/** 表示中の系統図がどこから来たか（DBの版 or プログラム内の仮想施設） */
export function useDiagramInfo(): DiagramSource {
  return useSyncExternalStore(subscribeDiagram, () => currentDiagram().info, () => currentDiagram().info);
}

/** ローカルストアを定期取得する（現場・制御室間の同期用。ローカルdevサーバー宛てのみ） */
export function usePipingStore(intervalMs = 1500) {
  const [store, setStore] = useState<PipingStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(-1);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchStore();
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
    const s = await dispatch(action);
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
