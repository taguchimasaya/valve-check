"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getFacility } from "./facility";
import { buildGraph, type Graph } from "./graph";
import { applyLayout, type PipingLayout } from "./layout";
import { dispatch, fetchStore, type PipingStore, type StoreAction } from "./store";

// 図面の配置（下絵に合わせた機器の位置）は保存データから読み込み、全画面の系統図に反映する。
let layoutKey = "";
let layoutLoaded = false;
let currentLayout: PipingLayout | undefined;
let graphCache: Graph | null = null;
const layoutListeners = new Set<() => void>();

function setCurrentLayout(layout: PipingLayout | undefined) {
  layoutLoaded = true;
  const key = JSON.stringify(layout?.positions ?? {});
  if (key === layoutKey) return;
  layoutKey = key;
  currentLayout = layout;
  graphCache = null;
  layoutListeners.forEach((l) => l());
}

function getGraph(): Graph {
  if (!graphCache) graphCache = buildGraph(applyLayout(getFacility(), currentLayout));
  return graphCache;
}

let baseGraphCache: Graph | null = null;
/** 配置を反映する前の（施設データそのままの）系統図 */
export function getBaseGraph(): Graph {
  if (!baseGraphCache) baseGraphCache = buildGraph(getFacility());
  return baseGraphCache;
}

export function useGraph(): Graph {
  // 保存データを読まない画面でも、保存済みの配置を反映する
  useEffect(() => {
    if (layoutLoaded) return;
    fetchStore()
      .then((s) => setCurrentLayout(s.layout))
      .catch(() => {});
  }, []);
  return useSyncExternalStore(
    (cb) => {
      layoutListeners.add(cb);
      return () => {
        layoutListeners.delete(cb);
      };
    },
    getGraph,
    getGraph
  );
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
        setCurrentLayout(s.layout);
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
    setCurrentLayout(s.layout);
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
