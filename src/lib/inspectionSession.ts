import { supabase } from "@/lib/supabase";

const STORAGE_KEY = "activeInspectionSessionId";

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

export async function getActiveSession(): Promise<InspectionSession | null> {
  if (typeof window === "undefined") return null;
  const id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) return null;
  const { data, error } = await supabase
    .from("inspection_sessions")
    .select("id, title, session_date")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return data;
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
  window.localStorage.setItem(STORAGE_KEY, data.id);
  return data;
}

export function clearActiveSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
