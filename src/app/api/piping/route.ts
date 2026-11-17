import { promises as fs } from "fs";
import path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, requireAuth, requireSite, rolesAtSite } from "@/lib/serverAuth";
import { can, deniedMessage, STORE_ACTION_PERMS } from "@/lib/roles";
import { EMPTY_STORE, execPlan, recordKey, type PipingStore, type StoreAction } from "@/lib/piping/store";
import { manualStepsOf, needsDayParams } from "@/lib/piping/workTypes";
import { outageDefOf } from "@/lib/piping/outages";
import { PERIOD_MAX } from "@/lib/piping/period";
import { approvalStages, approvalState, canApproveStage, isApprover, isCreator, STAGE_LABEL } from "@/lib/piping/approval";
import type { Role } from "@/lib/roles";
import { after } from "next/server";
import { notifyApproval } from "@/lib/approvalMail";
import { conflictText, duplicatePlan, isOwner, lineConflicts, startBlocker, targetConflicts } from "@/lib/piping/execRules";

/** 操作した人（ログイン中の利用者） */
type Actor = { name: string; userId: string; roles: Role[] };

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
  store.outages ??= [];
  // 下絵機能の廃止前に保存された配置データは読み捨てる
  delete (store as { layout?: unknown }).layout;
  // 工程名の変更（遮断 → ラインナップ）を、保存済みのチェックリストにも反映する
  store.plans.forEach((p) => {
    if (p.source === "planner") p.steps = p.steps.map((st) => (st === "遮断" ? "ラインナップ" : st));
  });
  return store;
}

// ───── ローカル（ファイル）保存 ─────
// 拠点（施設）ごとに分けて保存する。仮想施設は今までどおりの行・ファイル（main／piping-store.json）
const DEFAULT_FACILITY = "virtual-airport";
const facilityOf = (request: Request) => {
  const id = new URL(request.url).searchParams.get("facility") || DEFAULT_FACILITY;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("拠点IDが正しくありません");
  return id;
};

const DATA_DIR = path.join(process.cwd(), ".local-data");
const dataFile = (facility: string) =>
  path.join(DATA_DIR, facility === DEFAULT_FACILITY ? "piping-store.json" : `piping-store-${facility}.json`);

const memory = new Map<string, PipingStore>();
// 同時リクエストで読み書きが交錯しないよう、更新を直列化する
let queue: Promise<unknown> = Promise.resolve();

async function loadFile(facility: string): Promise<PipingStore> {
  let store = memory.get(facility);
  if (!store) {
    try {
      store = normalize(JSON.parse(await fs.readFile(dataFile(facility), "utf8")));
    } catch {
      store = normalize(null);
    }
  }
  store = normalize(store);
  memory.set(facility, store);
  return store;
}

async function saveFile(facility: string, store: PipingStore) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(dataFile(facility), JSON.stringify(store, null, 2), "utf8");
}

// ───── 本番（Supabase）保存 ─────
const rowId = (facility: string) => (facility === DEFAULT_FACILITY ? "main" : facility);


// テーブル未作成のエラー（PostgreSQL: 42P01、PostgREST: PGRST205）
const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

const TABLE_MISSING =
  "配管系統図の保存テーブル（piping_store）がありません。supabase/piping_store.sql を Supabase の SQL Editor で実行してください。";

/**
 * piping_store を読み書きする接続。
 * 利用者の権限では piping_store を直接読み書きできないようにし（supabase/security_lockdown.sql）、
 * この API がサーバー専用キー（service role）で読み書きする。API の確認（承認フロー・本人だけの操作など）を
 * ブラウザから Supabase を直接呼んですり抜けられないようにするため。
 * サーバー専用キーにまだ表の権限が無い（security_grant_service_role.sql の実行前）ときだけ、利用者の接続で読み書きする。
 */
let serviceReady = false;
async function storeClient(userClient: SupabaseClient): Promise<SupabaseClient> {
  const admin = adminClient();
  if (admin instanceof Response) return userClient;
  if (serviceReady) return admin;
  const { error } = await admin.from("piping_store").select("id").limit(1);
  if (error?.code === "42501") return userClient;
  serviceReady = !error;
  return admin;
}

async function loadDb(client: SupabaseClient, facility: string): Promise<PipingStore> {
  const { data, error } = await client.from("piping_store").select("data, version").eq("id", rowId(facility)).maybeSingle();
  if (error) throw new Error(isMissingTable(error.code) ? TABLE_MISSING : error.message);
  const store = normalize(data?.data as Partial<PipingStore> | undefined);
  store.version = data?.version ?? 0;
  return store;
}

/**
 * 読み込み → 更新 → 書き込み。サーバーが複数台で同時に動いても上書きし合わないよう、
 * version が読み込み時と同じときだけ書き込み、違えば読み直してやり直す（楽観的排他）。
 */
async function updateDb(client: SupabaseClient, facility: string, action: StoreAction, actor: Actor): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const store = await loadDb(client, facility);
    const before = store.version;
    const err = applyAs(store, action, actor);
    if (err) return new Response(err, { status: 400 });
    store.version = before + 1;
    const payload = { data: store, version: store.version, updated_at: new Date().toISOString() };
    const result =
      before === 0
        ? await client.from("piping_store").upsert({ id: rowId(facility), ...payload }).select("id")
        : await client.from("piping_store").update(payload).eq("id", rowId(facility)).eq("version", before).select("id");
    if (result.error) throw new Error(isMissingTable(result.error.code) ? TABLE_MISSING : result.error.message);
    if (result.data && result.data.length > 0) return Response.json(store);
  }
  return new Response("他の端末の更新と重なったため保存できませんでした。もう一度お試しください。", { status: 409 });
}

function stepTargets(store: PipingStore, execId: string, step: number) {
  const exec = store.executions.find((e) => e.id === execId);
  const raw = exec && store.plans.find((p) => p.id === exec.planId);
  if (!exec || !raw) return null;
  const plan = execPlan(raw, exec);
  // 充填ラインを使う作業で充填元が未選択なら、充填工程は完了にしない
  const waitingSupply =
    (plan.steps[step] === "充填" && (plan.fillPipeIds?.length ?? 0) > 0 && !exec.fillSupply) ||
    (needsDayParams(plan) && !exec.dayParams) ||
    // 循環・移送の工程は「完了」ボタンを押すまで完了にしない
    (manualStepsOf(plan).includes(step) && !exec.manualDone?.[step]);
  return { exec, plan, waitingSupply, codes: plan.rows.filter((r) => r.states[step]).map((r) => r.code) };
}

/**
 * 操作を当てはめ、この操作で増えた記録・経過・操作記録に「誰が」を付ける（ログイン中の利用者名）。
 */
function applyAs(store: PipingStore, a: StoreAction, who: Actor): string | null {
  const start = Date.now() - 1;
  const err = approvalCheck(store, a, who) ?? apply(store, a);
  if (err) return err;
  const actor = who.name;
  const isNew = (at?: string) => !!at && Date.parse(at) >= start;
  store.log.forEach((e) => isNew(e.at) && !e.by && (e.by = actor));
  store.executions.forEach((x) => {
    x.events.forEach((e) => isNew(e.at) && !e.by && (e.by = actor));
    Object.values(x.records).forEach((r) => {
      if (isNew(r.checkedAt) && !r.by) r.by = actor;
      if (isNew(r.confirmedAt) && !r.confirmedBy) r.confirmedBy = actor;
    });
  });
  if (a.action === "savePlan") {
    const plan = store.plans.find((p) => p.id === a.plan.id);
    if (plan) {
      plan.updatedBy = actor;
      plan.updatedById = who.userId;
    }
  }
  if (a.action === "startExecution") {
    const exec = store.executions.find((e) => e.id === a.id);
    if (exec) Object.assign(exec, { ownerId: who.userId, ownerName: actor });
  }
  if (a.action === "approveStart") {
    const exec = store.executions.find((e) => e.id === a.execId);
    if (exec) exec.approvedBy = actor;
  }
  if (a.action === "rejectStart") {
    const exec = store.executions.find((e) => e.id === a.execId);
    if (exec) exec.rejectedBy = actor;
  }
  if (a.action === "approvePlan") {
    const sign = store.plans.find((p) => p.id === a.id)?.approvals?.[a.stage];
    if (sign) Object.assign(sign, { by: actor, byId: who.userId });
  }
  if (a.action === "rejectPlan") {
    const rej = store.plans.find((p) => p.id === a.id)?.rejection;
    if (rej) rej.by = actor;
  }
  if (a.action === "applyDiagramImpact") {
    store.plans.forEach((p) => p.rejection && !p.rejection.by && (p.rejection.by = actor));
  }
  return null;
}

/**
 * 承認フローの確認（利用者が要るもの）：順番どおりの段か、その段の権限があるか、作成者本人でないか。
 * 点検の開始は、最後の段まで承認されたチェックリストだけ。
 */
function approvalCheck(store: PipingStore, a: StoreAction, who: Actor): string | null {
  const stages = approvalStages(store.rules);
  if (a.action === "approvePlan" || a.action === "rejectPlan") {
    const plan = store.plans.find((p) => p.id === a.id);
    if (!plan) return "チェックリストが見つかりません";
    if (isCreator(plan, who.userId, who.name)) return "作成者本人は承認・差し戻しできません";
    if (plan.rejection) return "差し戻し中です（作成者が直して承認依頼し直すまで、承認・差し戻しはできません）";
    if (a.action === "rejectPlan") {
      if (!isApprover(who.roles)) return "差し戻す権限がありません";
      if (!String(a.reason ?? "").trim()) return "差し戻しの理由を入力してください";
      return null;
    }
    const { next } = approvalState(plan, stages);
    if (!next) return "すでに最後まで承認されています";
    if (a.stage !== next) return `今は「${STAGE_LABEL[next]}」の承認の順番です（画面を読み込み直してください）`;
    if (!canApproveStage(who.roles, next)) return `「${STAGE_LABEL[next]}」の承認には、その権限が必要です`;
    return null;
  }
  if (a.action === "startExecution") {
    const plan = store.plans.find((p) => p.id === a.planId);
    if (plan && !approvalState(plan, stages).complete) return "承認が済んでいないチェックリストは開始できません（① で承認を受けてください）";
    // 同じ点検は同時にできない（だれの点検かは知らせない）
    // 同じ点検・同じ対象（機器）の点検は同時にできない（だれの点検かは知らせない）
    const blocker = plan && startBlocker(store, plan);
    if (blocker) return blocker;
  }
  if (a.action === "deletePlan" && !who.roles.includes("admin")) return "チェックリストの削除は管理者だけができます";
  if (a.action === "savePlan") {
    const dup = duplicatePlan(store.plans, a.plan);
    if (dup) {
      return `同じ作業・対象・周期のチェックリスト「${dup.name}」がすでにあります（周期を変えるか、既存のチェックリストを直してください）`;
    }
  }
  return execCheck(store, a, who);
}

/** 点検の操作の確認：持ち主だけが現場の操作をする・点検中の点検だけ記録できる・開始の承認は制御室 */
function execCheck(store: PipingStore, a: StoreAction, who: Actor): string | null {
  if (!("execId" in a)) return null;
  const exec = store.executions.find((e) => e.id === a.execId);
  if (!exec) return "点検が見つかりません";
  switch (a.action) {
    case "record":
    case "undoRecord":
    case "advanceStep":
    case "completeExecution":
    case "markStepDone": {
      // 工程の完了報告は制御室もできる。それ以外の現場の操作は開始した本人だけ
      const control = a.action === "markStepDone" && can(who.roles, "control");
      if (!control && !isOwner(exec, who.userId)) return "この点検は開始した本人だけが操作できます";
      if (exec.status === "pending") return "制御室の開始の承認を待っています（承認されると記録できます）";
      if (exec.status === "rejected") return "この点検開始は制御室で却下されました";
      if (exec.status !== "in_progress") return "この点検は完了しています";
      return null;
    }
    case "deleteExecution":
      if (!isOwner(exec, who.userId)) return "この点検は開始した本人だけが削除できます";
      return null;
    case "setDayParams":
    case "setFillSupply":
      if (exec.status === "completed") return "この点検は完了しています";
      return null;
    case "approveStart": {
      if (exec.status !== "pending") return "開始の申請中の点検ではありません";
      const raw = store.plans.find((p) => p.id === exec.planId);
      if (!raw) return "チェックリストが見つかりません";
      if (needsDayParams(raw) && !exec.dayParams) return "当日のタンク・ポンプを入力してから承認してください";
      // 制御室には、どの点検と重複しているかを知らせる
      const same = targetConflicts(store, raw, exec.id);
      if (same.length) {
        return `同じ機器を対象とする点検（${same.map((c) => `「${c.exec.planName}」`).join("・")}）が実施中のため、承認できません（却下してください）`;
      }
      if (startBlocker(store, raw, exec.id)) return "同じチェックリストの点検がほかにあるため、承認できません";
      const conflicts = lineConflicts(store, raw, exec.id);
      if (conflicts.length && !a.ackOverlap) return `ラインが重なる点検があります。確認のうえ承認してください：${conflicts.map(conflictText).join("／")}`;
      return null;
    }
    case "rejectStart":
      if (exec.status !== "pending") return "開始の申請中の点検ではありません";
      if (!String(a.reason ?? "").trim()) return "却下の理由を入力してください";
      return null;
    default:
      return null;
  }
}

function apply(store: PipingStore, a: StoreAction): string | null {
  const now = new Date().toISOString();
  switch (a.action) {
    case "savePlan": {
      // 保存（承認依頼）し直したチェックリストは内容が変わりうるため、承認・差し戻しを外して最初からやり直す
      delete a.plan.approvals;
      delete a.plan.rejection;
      const i = store.plans.findIndex((p) => p.id === a.plan.id);
      if (i >= 0) store.plans[i] = a.plan;
      else store.plans.unshift(a.plan);
      return null;
    }
    case "approvePlan": {
      // 順番・権限の確認は approvalCheck で済んでいる
      const plan = store.plans.find((p) => p.id === a.id);
      if (!plan) return "チェックリストが見つかりません";
      plan.approvals = { ...(plan.approvals ?? {}), [a.stage]: { by: "", at: now } };
      store.log.unshift({ at: now, type: "info", text: `チェックリスト「${plan.name}」を承認しました（${STAGE_LABEL[a.stage]}）` });
      store.log = store.log.slice(0, 100);
      return null;
    }
    case "rejectPlan": {
      const plan = store.plans.find((p) => p.id === a.id);
      if (!plan) return "チェックリストが見つかりません";
      const stage = approvalState(plan, approvalStages(store.rules)).next ?? "control";
      plan.rejection = { by: "", at: now, reason: String(a.reason).trim().slice(0, 500), stage };
      delete plan.approvals;
      store.log.unshift({ at: now, type: "info", text: `チェックリスト「${plan.name}」を差し戻しました：${plan.rejection.reason}` });
      store.log = store.log.slice(0, 100);
      return null;
    }
    case "setPlanPeriod": {
      const plan = store.plans.find((p) => p.id === a.id);
      if (!plan) return "チェックリストが見つかりません";
      const period = typeof a.period === "string" ? a.period.trim() : "";
      if (period.length > PERIOD_MAX) return `周期は${PERIOD_MAX}文字以内にしてください`;
      if (period) plan.period = period;
      else delete plan.period;
      return null;
    }
    case "deletePlan":
      // 管理者だけ（approvalCheck で確認済み）。点検中・承認待ちの点検があるときは消さない
      if (store.executions.some((e) => e.planId === a.id && (e.status === "pending" || e.status === "in_progress"))) {
        return "このチェックリストは点検中（または承認待ち）のため削除できません";
      }
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
        // 制御室が承認すると点検中になる（持ち主は applyAs で付ける）
        status: "pending",
        records: {},
        events: [{ at: now, type: "info", text: "点検の開始を申請しました（制御室の承認待ち）" }],
      });
      return null;
    }
    case "approveStart": {
      const exec = store.executions.find((e) => e.id === a.execId);
      const raw = exec && store.plans.find((p) => p.id === exec.planId);
      if (!exec || !raw) return "点検が見つかりません";
      const conflicts = lineConflicts(store, raw, exec.id);
      exec.status = "in_progress";
      exec.approvedAt = now;
      if (conflicts.length) exec.overlapAck = conflicts.map((c) => c.exec.planName);
      exec.events.unshift({
        at: now,
        type: "info",
        text: `制御室が点検の開始を承認しました${conflicts.length ? `（ラインの重なりを確認済み：${exec.overlapAck!.join("・")}）` : ""}`,
      });
      return null;
    }
    case "rejectStart": {
      const exec = store.executions.find((e) => e.id === a.execId);
      if (!exec) return "点検が見つかりません";
      // 本人に理由を知らせるため、却下として残す（本人が確認すると消える）
      exec.status = "rejected";
      exec.rejectedAt = now;
      exec.rejectReason = String(a.reason).trim().slice(0, 200);
      exec.events.unshift({ at: now, type: "info", text: `制御室が点検開始を却下しました：${exec.rejectReason}` });
      store.log.unshift({
        at: now,
        type: "info",
        text: `点検「${exec.planName}」${exec.ownerName ? `（${exec.ownerName}）` : ""}の点検開始を却下しました：${String(a.reason).trim().slice(0, 200)}`,
      });
      store.log = store.log.slice(0, 100);
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
      const done = !t.waitingSupply && t.codes.every((c) => t.exec.records[recordKey(a.step, c)]?.result === "OK");
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
      if (needsDayParams(plan) && !exec.dayParams) return "当日のタンク・ポンプを選んでから工程を進めてください";
      if (manualStepsOf(plan).includes(exec.currentStep) && !exec.manualDone?.[exec.currentStep]) {
        return "「完了」の報告がまだのため、次の工程へ進めません";
      }
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
    case "setOutage": {
      const def = outageDefOf(a.key, store.outageDefs);
      if (!def) return "停止範囲が見つかりません";
      const list = (store.outages ??= []);
      const i = list.findIndex((o) => o.key === a.key);
      if (a.on) {
        if (i >= 0) list[i].note = a.note ?? list[i].note;
        else list.push({ key: a.key, at: now, ...(a.note ? { note: a.note } : {}) });
      } else if (i >= 0) list.splice(i, 1);
      store.log.unshift({ at: now, type: "info", text: `制御室で「${def.label}」を${a.on ? "設定" : "解除"}しました` });
      store.log = store.log.slice(0, 100);
      return null;
    }
    case "clearOutages":
      store.outages = [];
      store.log.unshift({ at: now, type: "info", text: "制御室で運用停止範囲をすべて解除しました" });
      store.log = store.log.slice(0, 100);
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
    case "setDayParams": {
      const exec = store.executions.find((e) => e.id === a.execId);
      if (!exec) return "点検が見つかりません";
      if (Object.keys(exec.records).length) return "弁の記録があるため、当日の選択は変更できません";
      exec.dayParams = a.params;
      exec.extraRows = a.rows;
      exec.stepNotes = a.stepNotes;
      exec.stepRoutes = a.stepRoutes;
      const text =
        a.params.kind === "flush"
          ? `循環経路を ${a.params.srcTank} → ${a.params.pump} → 末端部 → ${a.params.returnTank} に設定しました`
          : `移送先を ${a.params.destTank}（払出ポンプ ${a.params.issuePump}・移送ポンプ ${a.params.transferPump}）に設定しました`;
      exec.events.unshift({ at: now, type: "info", text });
      return null;
    }
    case "markStepDone": {
      const t = stepTargets(store, a.execId, a.step);
      if (!t) return "点検が見つかりません";
      t.exec.manualDone = { ...(t.exec.manualDone ?? {}), [a.step]: now };
      const stepName = t.plan.steps[a.step];
      const valvesDone = t.codes.every((c) => t.exec.records[recordKey(a.step, c)]?.result === "OK");
      t.exec.events.unshift({ at: now, type: "info", text: `「${stepName}」の作業完了が報告されました` });
      if (valvesDone && !t.exec.events.some((e) => e.type === "step" && e.text.includes(`「${stepName}」`))) {
        t.exec.events.unshift({ at: now, type: "step", text: `工程「${stepName}」が完了しました` });
      }
      return null;
    }
    case "setFillSupply": {
      const exec = store.executions.find((e) => e.id === a.execId);
      if (!exec) return "点検が見つかりません";
      // すでに記録した経路の弁があるときは変更しない
      const recorded = (exec.extraRows ?? []).some((r) =>
        Object.keys(exec.records).some((k) => k.endsWith(`:${r.code}`))
      );
      if (recorded) return "充填元の経路の弁はすでに記録済みのため、変更できません";
      exec.fillSupply = a.fillSupply;
      exec.extraRows = a.rows;
      exec.events.unshift({
        at: now,
        type: "info",
        text: `充填元を ${a.fillSupply.tank}・移送ポンプ ${a.fillSupply.pump} に設定しました`,
      });
      return null;
    }
    case "setOutageDefs": {
      // 運用停止範囲の設定：形と重複だけ確認して保存する（空なら既定の範囲に戻る）
      const defs = Array.isArray(a.defs) ? a.defs : null;
      if (!defs) return "停止範囲の形式が正しくありません";
      const keys = new Set<string>();
      for (const d of defs) {
        if (!d || typeof d.key !== "string" || !d.key || typeof d.label !== "string" || !d.label.trim()) return "停止範囲の名前が空欄です";
        if (keys.has(d.key)) return `停止範囲「${d.label}」が重複しています`;
        if (![d.areas, d.nodes, d.exclude].every((x) => Array.isArray(x) && x.every((v) => typeof v === "string"))) return `停止範囲「${d.label}」の形式が正しくありません`;
        keys.add(d.key);
      }
      store.outageDefs = defs.map((d) => ({ key: d.key, label: d.label.trim(), desc: d.desc?.trim() || undefined, areas: d.areas, nodes: d.nodes, exclude: d.exclude, toJunctions: !!d.toJunctions }));
      // 無くなった範囲で停止中のものは解除する
      store.outages = (store.outages ?? []).filter((o) => !!outageDefOf(o.key, store.outageDefs));
      store.log.unshift({ at: now, type: "info", text: defs.length ? `運用停止範囲の設定を更新しました（${defs.length}件）` : "運用停止範囲の設定を既定に戻しました" });
      store.log = store.log.slice(0, 100);
      return null;
    }
    case "setRules": {
      // 消火設備機能試験のルール：口数・文字列の型だけ確認して保存する（細かな確認は画面側）
      const f = a.rules?.fireTest;
      if (f && (typeof f !== "object" || Array.isArray(f))) return "ルールの形式が正しくありません";
      store.rules = { ...a.rules, updatedAt: now };
      store.log.unshift({ at: now, type: "info", text: `チェックリスト作成のルールを更新しました${a.by ? `（${a.by}）` : ""}` });
      store.log = store.log.slice(0, 100);
      return null;
    }
    case "applyDiagramImpact": {
      if (typeof a.versionId !== "string" || !a.versionId || !Array.isArray(a.results)) return "影響チェックの結果の形式が正しくありません";
      const ids = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
      const PATCH_KEYS = ["regionPipeIds", "sealPipeIds", "fillPipeIds", "flushPipeIds", "targets", "stepRoutes"];
      let updated = 0;
      let returned = 0;
      for (const r of a.results) {
        const plan = store.plans.find((p) => p.id === r?.planId);
        if (!plan) continue;
        if (r.level === "remake") {
          const reasons = (Array.isArray(r.reasons) ? r.reasons : []).map(String);
          const more = reasons.length > 3 ? `ほか${reasons.length - 3}件` : "";
          const stage = approvalState(plan, approvalStages(store.rules)).next ?? "control";
          plan.rejection = {
            by: "",
            at: now,
            reason: `系統図の第${a.versionNo}版への更新で作り直しが必要です：${reasons.slice(0, 3).join("／")}${more}`.slice(0, 500),
            stage,
          };
          delete plan.approvals;
          returned++;
        } else if (r.level === "none" || r.level === "drawing") {
          if (r.level === "drawing" && r.patch) {
            const p = r.patch as Record<string, unknown>;
            if (Object.keys(p).some((k) => !PATCH_KEYS.includes(k))) return "影響チェックの付け替えの形式が正しくありません";
            if (["regionPipeIds", "sealPipeIds", "fillPipeIds", "flushPipeIds"].some((k) => k in p && !ids(p[k]))) return "影響チェックの付け替えの形式が正しくありません";
            Object.assign(plan, r.patch);
          }
          plan.diagramVersionId = a.versionId;
          updated++;
        } else return "影響チェックの判定が正しくありません";
      }
      store.log.unshift({
        at: now,
        type: "info",
        text: `系統図の第${a.versionNo}版への更新に合わせてチェックリストを見直しました（版の更新 ${updated}件・差し戻し ${returned}件）`,
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

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const facility = facilityOf(request);
    // 権限のある拠点（どこかの拠点で制御室の人は、ほかの拠点も表示だけ）
    const site = requireSite(auth, facility);
    if (site instanceof Response) return site;
    return Response.json(BACKEND === "supabase" ? await loadDb(await storeClient(auth.client), facility) : await loadFile(facility));
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const action = (await request.json()) as StoreAction;
  // 操作ごとの権限（src/lib/roles.ts の STORE_ACTION_PERMS）。載っていない操作は受け付けない
  const perms = STORE_ACTION_PERMS[action?.action];
  if (!perms) return new Response("不明な操作です", { status: 400 });
  let facility: string;
  try {
    facility = facilityOf(request);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
  }
  // 操作はその拠点での権限で判断する（表示だけの拠点では何もできない）
  const roles = rolesAtSite(auth, facility);
  if (!can(roles, ...perms)) return new Response(roles.length ? deniedMessage(perms) : "この拠点で操作する権限がありません", { status: 403 });
  let res: Response;
  if (BACKEND === "supabase") {
    try {
      res = await updateDb(await storeClient(auth.client), facility, action, { name: auth.name, userId: auth.userId, roles });
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
    }
  } else {
    const run = queue.then(async () => {
      const store = await loadFile(facility);
      const err = applyAs(store, action, { name: auth.name, userId: auth.userId, roles });
      if (err) return new Response(err, { status: 400 });
      store.version += 1;
      await saveFile(facility, store);
      return Response.json(store);
    });
    queue = run.catch(() => {});
    res = await run;
  }
  // 承認フローの操作（承認依頼・承認・差し戻し）が成功したら、応答を返したあとにメールで知らせる（⑤ の設定がオンの拠点だけ）
  if (res.ok && (action.action === "savePlan" || action.action === "approvePlan" || action.action === "rejectPlan")) {
    const store = (await res.clone().json()) as PipingStore;
    const origin = new URL(request.url).origin;
    after(() => notifyApproval({ action, store, facility, origin, client: auth.client }).catch((e) => console.error("[approval mail]", e)));
  }
  return res;
}
