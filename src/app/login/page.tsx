"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn, useSession } from "@/lib/auth";

// ログイン画面：ID とパスワード。ログイン後は元の画面（?next=）へ戻る。

function safeNext(next: string | null) {
  // 同じアプリ内のパスだけを許す（外部サイトへの転送を防ぐ）
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const session = useSession();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // すでにログインしていれば元の画面へ
  useEffect(() => {
    if (session) router.replace(next);
  }, [session, next, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!id.trim() || !password) {
      setError("ID とパスワードを入力してください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(id, password);
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
    >
      <p className="text-sm font-medium text-zinc-500">Valve Inspection App</p>
      <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">バルブ点検アプリ</h1>
      <p className="mt-1 text-sm text-zinc-500">ID とパスワードでログインしてください。</p>
      <label className="mt-6 block text-sm">
        <span className="text-zinc-600 dark:text-zinc-300">ID</span>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoFocus
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-base dark:border-zinc-700"
        />
      </label>
      <label className="mt-4 block text-sm">
        <span className="text-zinc-600 dark:text-zinc-300">パスワード</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-base dark:border-zinc-700"
        />
      </label>
      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="mt-6 w-full rounded-lg bg-emerald-700 py-2.5 text-base font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        {busy ? "ログイン中…" : "ログイン"}
      </button>
      <p className="mt-4 text-xs text-zinc-400">ID・パスワードが分からない場合は管理者に確認してください。</p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <Suspense fallback={<p className="text-sm text-zinc-500">読み込み中…</p>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
