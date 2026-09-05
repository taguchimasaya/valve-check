import { supabase } from "@/lib/supabase";

export type InspectionSession = {
  id: string;
  title: string;
  session_date: string;
  status: string;
  current_item_id: string | null;
  current_checklist_template_id: string | null;
};

function todayLabel() {
  return new Date().toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// 複数の進行中セッションを取得する（制御室が複数セッションを監視するため）
export async function getActiveSessions(): Promise<InspectionSession[]> {
  const { data } = await supabase
    .from("inspection_sessions")
    .select("id, title, session_date, status, current_item_id, current_checklist_template_id")
    .eq("status", "in_progress")
    .order("created_at", { ascending: false });
  return data ?? [];
}

// 互換性のため、最後の進行中セッション1つを取得（現場で使用）
export async function getActiveSession(): Promise<InspectionSession | null> {
  const sessions = await getActiveSessions();
  return sessions.length > 0 ? sessions[0] : null;
}

export async function ensureActiveSession(): Promise<InspectionSession | null> {
  // 既存の進行中セッションを確認
  let existing = await getActiveSession();
  if (existing) return existing;

  // 進行中セッションがない場合は新規作成
  const { data, error } = await supabase
    .from("inspection_sessions")
    .insert({ title: `${todayLabel()} の点検`, status: "in_progress" })
    .select("id, title, session_date, status, current_item_id, current_checklist_template_id")
    .single();

  if (error || !data) return null;

  // 新規作成したセッションを返す
  return data;
}

// セッションの現在工程を更新する
export async function setCurrentStep(
  sessionId: string,
  checklistTemplateId: string,
  itemId: string | null
): Promise<boolean> {
  const { error } = await supabase
    .from("inspection_sessions")
    .update({
      current_checklist_template_id: checklistTemplateId,
      current_item_id: itemId,
    })
    .eq("id", sessionId);
  return !error;
}

// 進行中のセッションをすべて完了扱いにし、新しいセッションを開始する。
export async function startNewSession(): Promise<InspectionSession | null> {
  await supabase
    .from("inspection_sessions")
    .update({ status: "completed" })
    .eq("status", "in_progress");
  return ensureActiveSession();
}
