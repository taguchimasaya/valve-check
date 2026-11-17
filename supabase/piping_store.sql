-- 配管系統図機能（抜取チェックリスト作成・図面での現場点検・制御室）の保存テーブル
-- Supabaseダッシュボード → SQL Editor → New query に貼り付けて実行してください。
-- 既存のテーブル（equipment / checklist_* / inspection_* など）には一切変更を加えません。
-- 何度実行しても問題ありません。

-- チェックリスト・点検記録・運用入力・弁の手動変更を、1行のJSONとしてまとめて保存する。
-- version は同時更新の衝突検出用（読み込んだ時と同じ version のときだけ上書きする）。
create table if not exists piping_store (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into piping_store (id) values ('main') on conflict (id) do nothing;

-- 2026-11-17：読み書きはアプリの API（/api/piping）がサーバー専用キー（service role）で行う。
-- 利用者（anon / authenticated）には読み書きの権限を与えない（API の確認をすり抜けられないようにするため）。
-- 詳しくは supabase/security_lockdown.sql。
grant select, insert, update, delete on piping_store to service_role;
alter table piping_store enable row level security;
