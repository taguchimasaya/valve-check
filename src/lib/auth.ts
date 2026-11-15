"use client";

import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

// ログイン（Supabase Auth）。利用者は ID とパスワードでログインする。
// Supabase Auth はメールアドレスで管理するため、ID は「ID@valve-check.local」に置き換えて扱う
// （@ を含む入力はメールアドレスとしてそのまま使う）。利用者は Supabase の管理画面で作成する。

export const LOGIN_DOMAIN = "valve-check.local";

export function idToEmail(id: string) {
  const v = id.trim().toLowerCase();
  return v.includes("@") ? v : `${v}@${LOGIN_DOMAIN}`;
}

/** 画面に出す名前：利用者情報の名前、無ければ ID（メールの @ より前） */
export function displayName(user: Pick<User, "email" | "user_metadata"> | null | undefined) {
  if (!user) return "";
  const meta = user.user_metadata as { name?: string; display_name?: string } | undefined;
  return meta?.name || meta?.display_name || (user.email ?? "").replace(`@${LOGIN_DOMAIN}`, "");
}

export async function signIn(id: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email: idToEmail(id), password });
  if (error) {
    throw new Error(error.message.includes("Invalid login") ? "ID またはパスワードが違います" : error.message);
  }
}

export async function signOut() {
  await supabase.auth.signOut();
}

/** ログイン中のセッション（読み込み中は undefined、未ログインは null） */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

/** アプリの API を呼ぶ fetch。ログイン中のトークンを付ける */
export async function authFetch(input: string, init: RequestInit = {}) {
  const { data } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  const res = await fetch(input, { ...init, headers });
  // ログインが切れていれば、ログアウトしてログイン画面へ（AuthGate が移動する）
  if (res.status === 401) await supabase.auth.signOut();
  return res;
}
