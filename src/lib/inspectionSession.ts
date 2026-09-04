import { supabase } from "@/lib/supabase";

export type InspectionSession = {
  id: string;
  title: string;
  session_date: string;
};

function todayLabel() {
  return new Date().toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// セッションは端末ごとではなく、進行中のもの（status = in_progress）を
// DBから探して全端末で共有する。こうすることで、現場のiPadと制御室のPCが
// 自動的に同じ点検セッションを見ることになり、事前の共有作業が要らない。
export async function getActiveSession(): Promise<InspectionSession | null> {
  const { data } = await supabase
    .from("inspection_sessions")
    .select("id, title, session_date")
    .eq("status", "in_progress")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function ensureActiveSession(): Promise<InspectionSession | null> {
  const existing = await getActiveSession();
  if (existing) return existing;

  const { data, error } = await supabase
    .from("inspection_sessions")
    .insert({ title: `${todayLabel()} の点検`, status: "in_progress" })
    .select("id, title, session_date")
    .single();

  if (error || !data) return null;
  return data;
}

// 進行中のセッションをすべて完了扱いにし、新しいセッションを開始する。
export async function startNewSession(): Promise<InspectionSession | null> {
  await supabase
    .from("inspection_sessions")
    .update({ status: "completed" })
    .eq("status", "in_progress");
  return ensureActiveSession();
}
