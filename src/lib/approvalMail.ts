import type { SupabaseClient, User } from "@supabase/supabase-js";
import { adminClient, isDisabled, rolesOf } from "./serverAuth";
import { BACKSTAGE_ROLES, currentGrants, rolesAt } from "./roles";
import { approvalRulesOf, approvalStages, approvalState, STAGE_LABEL, STAGE_PERM, type ApprovalStage } from "./piping/approval";
import type { SavedPlan } from "./piping/checklist";
import type { PipingStore, StoreAction } from "./piping/store";

// 承認フローのメール通知（サーバー側だけで使う）。送信方法は環境変数で決める：
// - Gmail などの SMTP：SMTP_USER・SMTP_PASS（Gmail はアプリ パスワード）。SMTP_HOST（既定 smtp.gmail.com）・SMTP_PORT（既定 465）
// - Resend：RESEND_API_KEY（SMTP の設定が無いとき）
// 送信元は MAIL_FROM（無ければ SMTP_USER）。どちらも無ければ送らない。
// ⑤ 共通の「承認フローのメールを送る」がオンの拠点だけ送る。宛先は利用者ごとの通知先メール（user_metadata.notify_email）。
// - 承認依頼・各段の承認：その拠点で次の段の権限を持つ全員（管理者だけの人には送らない）
// - 差し戻し・最後の段の承認：作成者
// 送れなくても操作は成功のまま（ログに残すだけ）。

const RESEND_URL = "https://api.resend.com/emails/batch";
const DEFAULT_FROM = "バルブ点検アプリ <onboarding@resend.dev>";

export const notifyEmailOf = (u: Pick<User, "user_metadata">) => {
  const v = (u.user_metadata as { notify_email?: unknown } | undefined)?.notify_email;
  return typeof v === "string" && v.includes("@") ? v : null;
};

type Mail = { to: string; subject: string; text: string };

/** 使う送信方法（設定が無ければ null） */
export function mailMethod(): "smtp" | "resend" | null {
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return "smtp";
  if (process.env.RESEND_API_KEY) return "resend";
  return null;
}

/** メールを送る。失敗したら例外（呼ぶ側でログに残す） */
export async function sendMails(mails: Mail[]) {
  const method = mailMethod();
  if (!method || !mails.length) return;
  if (method === "smtp") {
    const { createTransport } = await import("nodemailer");
    const port = Number(process.env.SMTP_PORT || 465);
    const transport = createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const from = process.env.MAIL_FROM || `バルブ点検アプリ <${process.env.SMTP_USER}>`;
    // Gmail の送信数の上限に配慮して1通ずつ順に送る
    for (const m of mails) await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text });
    return;
  }
  const from = process.env.MAIL_FROM || DEFAULT_FROM;
  // 1回で最大100通
  for (let i = 0; i < mails.length; i += 100) {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(mails.slice(i, i + 100).map((m) => ({ from, to: [m.to], subject: m.subject, text: m.text }))),
    });
    if (!res.ok) throw new Error(`Resend への送信に失敗しました（${res.status}）：${await res.text()}`);
  }
}

function statusLine(plan: SavedPlan, stages: ApprovalStage[]) {
  return [`作成 ${plan.updatedBy ?? "?"}`, ...stages.map((s) => `${STAGE_LABEL[s]} ${plan.approvals?.[s] ? `✔ ${plan.approvals[s]!.by}` : "未"}`)].join(" → ");
}

/** 承認フローの操作（承認依頼・承認・差し戻し）のあとに、次に動く人へメールを送る */
export async function notifyApproval(opts: {
  action: StoreAction;
  store: PipingStore;
  facility: string;
  origin: string;
  /** 拠点名を読むための、操作した利用者の接続（service role には拠点テーブルの読み取り権限が無い） */
  client?: SupabaseClient;
}) {
  const { action, store, facility, origin, client } = opts;
  if (!mailMethod()) return;
  if (!approvalRulesOf(store.rules).notifyEmail) return;
  const id = action.action === "savePlan" ? action.plan.id : action.action === "approvePlan" || action.action === "rejectPlan" ? action.id : null;
  const plan = id ? store.plans.find((p) => p.id === id) : undefined;
  if (!plan) return;
  const admin = adminClient();
  if (admin instanceof Response) return;

  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return console.error("[approval mail] 利用者を読めませんでした", error.message);
  const users = data.users.filter((u) => !isDisabled(u) && notifyEmailOf(u));
  const fac = client ? (await client.from("piping_facilities").select("name").eq("id", facility).maybeSingle()).data : null;
  const facilityName = (fac?.name as string | undefined) ?? facility;

  const stages = approvalStages(store.rules);
  const { next, complete } = approvalState(plan, stages);
  const head = `拠点：${facilityName}\nチェックリスト：${plan.name}\n作業：${plan.purpose}${plan.period ? `（周期 ${plan.period}）` : ""}\n承認の状況：${statusLine(plan, stages)}\n`;
  const foot = "\n※このメールは送信専用です。拠点はアプリの画面で切り替えてください。\n";
  const creator = plan.updatedById ? data.users.find((u) => u.id === plan.updatedById) : undefined;
  const creatorMail = creator && !isDisabled(creator) ? notifyEmailOf(creator) : null;
  const mails: Mail[] = [];

  if (action.action === "rejectPlan" && plan.rejection) {
    if (creatorMail) {
      mails.push({
        to: creatorMail,
        subject: `【バルブ点検】差し戻し：${plan.name}`,
        text: `チェックリスト「${plan.name}」が差し戻されました（${STAGE_LABEL[plan.rejection.stage]}：${plan.rejection.by}）。\n理由：${plan.rejection.reason}\n\n${head}\n① チェックリスト作成で直して、承認依頼し直してください。\n${origin}/piping/planner\n${foot}`,
      });
    }
  } else if (complete) {
    if (action.action === "approvePlan" && creatorMail) {
      mails.push({
        to: creatorMail,
        subject: `【バルブ点検】承認完了：${plan.name}`,
        text: `チェックリスト「${plan.name}」の承認がすべて終わりました。② 現場点検で開始できます。\n\n${head}\n${origin}/piping/field\n${foot}`,
      });
    }
  } else if (next) {
    // 次の段を承認できる人（作成者本人は承認できないので除く）。管理者はどの段も承認できるが、
    // 毎回のお知らせが届かないよう、ほかのロールでその段を承認できる人がいないときだけ送る（外部ベンダーには送らない）
    const perm = STAGE_PERM[next];
    const holders = users.filter((u) => u.id !== plan.updatedById && rolesAt(rolesOf(u), facility).some((r) => !BACKSTAGE_ROLES.includes(r) && currentGrants()[r].includes(perm)));
    const targets = holders.length ? holders : users.filter((u) => u.id !== plan.updatedById && rolesAt(rolesOf(u), facility).some((r) => r === "admin" && currentGrants()[r].includes(perm)));
    for (const u of targets) {
      mails.push({
        to: notifyEmailOf(u)!,
        subject: `【バルブ点検】承認のお願い（${STAGE_LABEL[next]}）：${plan.name}`,
        text: `チェックリスト「${plan.name}」の承認をお願いします（${STAGE_LABEL[next]}の段）。\n\n${head}\n① チェックリスト確認・承認で、プレビューを確かめて承認または差し戻ししてください。\n${origin}/piping/planner\n${foot}`,
      });
    }
  }
  await sendMails(mails);
}
