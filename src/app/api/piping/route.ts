import { promises as fs } from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { EMPTY_STORE, recordKey, type PipingStore, type StoreAction } from "@/lib/piping/store";

// 配管系統図機能の保存API。保存先は2種類：
// - 本番（Vercel）：Supabase の piping_store テーブル（1行のJSON。既存システムのテーブルとは別）
// - ローカル（next dev）：このPCの .local-data/piping-store.json（本番データには書き込まない）
// PIPING_STORE=supabase / file で明示的に切り替えることもできる。

const BACKEND: "supabase" | "file" =
  process.env.PIPING_STORE === "supabase" || process.env.PIPING_STORE === "file"
    ? process.env.PIPING_STORE
    : process.env.VERCEL
      ? "supabase"
      : "file";

/** 保存データを現在の形式にそろえる（古い形式のデータにも新しい項目を補う） */
function normalize(raw: Partial<PipingStore> | null | undefined): PipingStore {
  const store: PipingStore = { ...structuredClone(EMPTY_STORE), ...(raw ?? {}) };
  store.valveOverrides ??= {};
  store.log ??= [];
  // 工程名の変更（遮断 → ラインナップ）を、保存済みのチェックリストにも反映する
  store.plans.forEach((p) => {
    if (p.source === "planner") p.steps = p.steps.map((st) => (st === "遮断" ? "ラインナップ" : st));
  });
  return store;
}

// ───── ローカル（ファイル）保存 ─────
const DATA_DIR = path.join(process.cwd(), ".local-data");
const DATA_FILE = path.join(DATA_DIR, "piping-store.json");

let memory: PipingStore | null = null;
// 同時リクエストで読み書きが交錯しないよう、更新を直列化する
let queue: Promise<unknown> = Promise.resolve();

async function loadFile(): Promise<PipingStore> {
  if (!memory) {
    try {
      memory = normalize(JSON.parse(await fs.readFile(DATA_FILE, "utf8")));
    } catch {
      memory = normalize(null);
    }
  }
  memory = normalize(memory);
  return memory;
}

async function saveFile(store: PipingStore) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

// ───── 本番（Supabase）保存 ─────
const ROW_ID = "main";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabaseの接続情報が設定されていません");
  return createClient(url, key, { auth: { persistSession: false } });
}

// テーブル未作成のエラー（PostgreSQL: 42P01、PostgREST: PGRST205）
const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

const TABLE_MISSING =
  "配管系統図の保存テーブル（piping_store）がありません。supabase/piping_store.sql を Supabase の SQL Editor で実行してください。";

async function loadDb(): Promise<PipingStore> {
  const { data, error } = await db().from("piping_store").select("data, version").eq("id", ROW_ID).maybeSingle();
  if (error) throw new Error(isMissingTable(error.code) ? TABLE_MISSING : error.message);
  const store = normalize(data?.data as Partial<PipingStore> | undefined);
  store.version = data?.version ?? 0;
  return store;
}

/**
 * 読み込み → 更新 → 書き込み。サーバーが複数台で同時に動いても上書きし合わないよう、
 * version が読み込み時と同じときだけ書き込み、違えば読み直してやり直す（楽観的排他）。
 */
async function updateDb(action: StoreAction): Promise<Response> {
  const client = db();
  for (let attempt = 0; attempt < 5; attempt++) {
    const store = await loadDb();
    const before = store.version;
    const err = apply(store, action);
    if (err) return new Response(err, { status: 400 });
    store.version = before + 1;
    const payload = { data: store, version: store.version, updated_at: new Date().toISOString() };
    const result =
      before === 0
        ? await client.from("piping_store").upsert({ id: ROW_ID, ...payload }).select("id")
        : await client.from("piping_store").update(payload).eq("id", ROW_ID).eq("version", before).select("id");
    if (result.error) throw new Error(isMissingTable(result.error.code) ? TABLE_MISSING : result.error.message);
    if (result.data && result.data.length > 0) return Response.json(store);
  }
  return new Response("他の端末の更新と重なったため保存できませんでした。もう一度お試しください。", { status: 409 });
}

function stepTargets(store: PipingStore, execId: string, step: number) {
  const exec = store.executions.find((e) => e.id === execId);
  const plan = exec && store.plans.find((p) => p.id === exec.planId);
  if (!exec || !plan) return null;
  return { exec, plan, codes: plan.rows.filter((r) => r.states[step]).map((r) => r.code) };
}

function apply(store: PipingStore, a: StoreAction): string | null {
  const now = new Date().toISOString();
  switch (a.action) {
    case "savePlan": {
      const i = store.plans.findIndex((p) => p.id === a.plan.id);
      if (i >= 0) store.plans[i] = a.plan;
      else store.plans.unshift(a.plan);
      return null;
    }
    case "deletePlan":
      store.plans = store.plans.filter((p) => p.id !== a.id);
      store.executions = store.executions.filter((e) => e.planId !== a.id);
      return null;
    case "startExecution": {
      const plan = store.plans.find((p) => p.id === a.planId);
      if (!plan) return "チェックリストが見つかりません";
      store.executions.unshift({
        id: a.id,
        planId: plan.id,
        planName: plan.name,
        startedAt: now,
        currentStep: Math.min(1, plan.steps.length - 1),
        status: "in_progress",
        records: {},
        events: [{ at: now, type: "info", text: "点検を開始しました" }],
      });
      return null;
    }
    case "record": {
      const t = stepTargets(store, a.execId, a.step);
      if (!t) return "点検が見つかりません";
      const row = t.plan.rows.find((r) => r.code === a.code);
      const target = row?.states[a.step];
      t.exec.records[recordKey(a.step, a.code)] = { result: a.result, checkedAt: now };
      const verb = row && isOperate(row.states, a.step) ? "操作" : "確認";
      t.exec.events.unshift({
        at: now,
        type: "valve",
        text:
          a.result === "OK"
            ? `${a.code} を${target === "close" ? "閉" : "開"}${verb}しました`
            : `${a.code} で異常（NG）が報告されました`,
      });
      const done = t.codes.every((c) => t.exec.records[recordKey(a.step, c)]?.result === "OK");
      if (done && !t.exec.events.some((e) => e.type === "step" && e.text.includes(`「${t.plan.steps[a.step]}」`))) {
        t.exec.events.unshift({ at: now, type: "step", text: `工程「${t.plan.steps[a.step]}」が完了しました` });
      }
      return null;
    }
    case "undoRecord": {
      const exec = store.executions.find((e) => e.id === a.execId);
      if (!exec) return "点検が見つかりません";
      delete exec.records[recordKey(a.step, a.code)];
      return null;
    }
    case "confirm": {
      const exec = store.executions.find((e) => e.id === a.execId);
      const rec = exec?.records[recordKey(a.step, a.code)];
      if (!rec) return "現場の記録がありません";
      rec.confirmedAt = now;
      return null;
    }
    case "advanceStep": {
      const exec = store.executions.find((e) => e.id === a.execId);
      const plan = exec && store.plans.find((p) => p.id === exec.planId);
      if (!exec || !plan) return "点検が見つかりません";
      if (exec.currentStep < plan.steps.length - 1) {
        exec.currentStep += 1;
        exec.events.unshift({ at: now, type: "info", text: `工程「${plan.steps[exec.currentStep]}」を開始しました` });
      }
      return null;
    }
    case "completeExecution": {
      const exec = store.executions.find((e) => e.id === a.execId);
      if (!exec) return "点検が見つかりません";
      exec.status = "completed";
      exec.events.unshift({ at: now, type: "info", text: "全工程が完了しました" });
      return null;
    }
    case "deleteExecution":
      store.executions = store.executions.filter((e) => e.id !== a.execId);
      return null;
    case "setOperations":
      store.operations = a.operations;
      return null;
    case "setValve": {
      if (a.state) store.valveOverrides[a.id] = a.state;
      else delete store.valveOverrides[a.id];
      store.log.unshift({
        at: now,
        type: "info",
        text: a.state
          ? `制御室で ${a.label} を「${a.state === "open" ? "開" : "閉"}」に変更しました`
          : `制御室で ${a.label} の手動変更を解除しました`,
      });
      store.log = store.log.slice(0, 100);
      return null;
    }
    case "clearValveOverrides":
      store.valveOverrides = {};
      store.log.unshift({ at: now, type: "info", text: "制御室で弁の手動変更をすべて解除しました" });
      store.log = store.log.slice(0, 100);
      return null;
  }
}

function isOperate(states: (string | null)[], step: number) {
  for (let i = step - 1; i >= 0; i--) if (states[i]) return states[i] !== states[step];
  return step !== 0;
}

export async function GET() {
  try {
    return Response.json(BACKEND === "supabase" ? await loadDb() : await loadFile());
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}

export async function POST(request: Request) {
  const action = (await request.json()) as StoreAction;
  if (BACKEND === "supabase") {
    try {
      return await updateDb(action);
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
    }
  }
  const run = queue.then(async () => {
    const store = await loadFile();
    const err = apply(store, action);
    if (err) return new Response(err, { status: 400 });
    store.version += 1;
    await saveFile(store);
    return Response.json(store);
  });
  queue = run.catch(() => {});
  return run;
}
