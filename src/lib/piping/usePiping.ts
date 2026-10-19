"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getFacility } from "./facility";
import { buildGraph, type Graph } from "./graph";
import { dispatch, fetchStore, type PipingStore, type StoreAction } from "./store";

let graphCache: Graph | null = null;
function getGraph(): Graph {
  if (!graphCache) graphCache = buildGraph(getFacility());
  return graphCache;
}
export function useGraph(): Graph {
  return getGraph();
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
