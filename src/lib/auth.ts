"use client";

import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Role } from "./roles";

// ログイン（Supabase Auth）。利用者は ID とパスワードでログインする。
// ID はメールアドレスの @ より前（例：test@test.com なら「test」）。
// DB の関数 login_email（supabase/auth_login_id.sql）で、ID からメールアドレスを探してログインする。
// 関数が無い・見つからないときは「ID@valve-check.local」として扱う。@ を含む入力はメールアドレスとしてそのまま使う。
// 利用者は管理者がアプリのユーザー管理（/admin/users）で作成する。権限は src/lib/roles.ts。

export const LOGIN_DOMAIN = "valve-check.local";

/** 入力された ID からログインに使うメールアドレスを決める */
export async function resolveLoginEmail(id: string) {
  const v = id.trim().toLowerCase();
  if (v.includes("@")) return v;
  const { data, error } = await supabase.rpc("login_email", { login_id: v });
  if (!error && typeof data === "string" && data) return data;
  return `${v}@${LOGIN_DOMAIN}`;
}

/** 画面に出す名前：利用者情報の名前、無ければ ID（メールの @ より前） */
export function displayName(user: Pick<User, "email" | "user_metadata"> | null | undefined) {
  if (!user) return "";
  const meta = user.user_metadata as { name?: string; display_name?: string } | undefined;
  return meta?.name || meta?.display_name || (user.email ?? "").split("@")[0];
}

export async function signIn(id: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email: await resolveLoginEmail(id), password });
  if (error) {
    throw new Error(error.message.includes("Invalid login") ? "ID またはパスワードが違います" : error.message);
  }
}

export async function signOut() {
  await supabase.auth.signOut({ scope: "local" });
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
  if (res.status === 401) await supabase.auth.signOut({ scope: "local" });
  return res;
}

/** ログイン中の利用者の権限（/api/me）。サーバーで Supabase Auth に問い合わせて決める */
export type Me = { userId: string; name: string; loginId: string; roles: Role[]; envAdmin: boolean };

// 同じ利用者のあいだは1回だけ問い合わせる（画面を移っても使い回す）
let meCache: { userId: string; promise: Promise<Me | null> } | null = null;
const meListeners = new Set<() => void>();

function loadMe(userId: string, force = false) {
  if (!force && meCache?.userId === userId) return meCache.promise;
  const promise = authFetch("/api/me", { cache: "no-store" })
    .then(async (res) => (res.ok ? ((await res.json()) as Me) : null))
    .catch(() => null);
  meCache = { userId, promise };
  return promise;
}

/** 権限を読み直す（自分の権限を変えたときなど） */
export function refreshMe() {
  if (meCache) loadMe(meCache.userId, true);
  meListeners.forEach((f) => f());
}

/** ログイン中の利用者と権限（読み込み中は undefined、未ログイン・読めないときは null） */
export function useMe(): Me | null | undefined {
  const session = useSession();
  const userId = session?.user.id;
  const [state, setState] = useState<{ userId?: string; me: Me | null | undefined }>({ me: undefined });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    meListeners.add(f);
    return () => {
      meListeners.delete(f);
    };
  }, []);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    loadMe(userId).then((me) => alive && setState({ userId, me }));
    return () => {
      alive = false;
    };
  }, [userId, tick]);
  if (session === null) return null;
  if (!userId || state.userId !== userId) return undefined;
  return state.me;
}
