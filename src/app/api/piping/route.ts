import { promises as fs } from "fs";
import path from "path";
import { EMPTY_STORE, recordKey, type PipingStore, type StoreAction } from "@/lib/piping/store";

// 配管系統図機能のローカル保存API。
// データは dev サーバーを動かしているPCの .local-data/piping-store.json に保存し、
// 既存システムの Supabase には一切アクセスしない。

const DATA_DIR = path.join(process.cwd(), ".local-data");
const DATA_FILE = path.join(DATA_DIR, "piping-store.json");

let memory: PipingStore | null = null;
// 同時リクエストで読み書きが交錯しないよう、更新を直列化する
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<PipingStore> {
  if (memory) return memory;
  try {
    memory = { ...EMPTY_STORE, ...JSON.parse(await fs.readFile(DATA_FILE, "utf8")) };
  } catch {
    memory = structuredClone(EMPTY_STORE);
  }
  return memory!;
}

async function save(store: PipingStore) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
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
  }
}

function isOperate(states: (string | null)[], step: number) {
  for (let i = step - 1; i >= 0; i--) if (states[i]) return states[i] !== states[step];
  return step !== 0;
}

export async function GET() {
  return Response.json(await load());
}

export async function POST(request: Request) {
  const action = (await request.json()) as StoreAction;
  const run = queue.then(async () => {
    const store = await load();
    const err = apply(store, action);
    if (err) return new Response(err, { status: 400 });
    store.version += 1;
    await save(store);
    return Response.json(store);
  });
  queue = run.catch(() => {});
  return run;
}
