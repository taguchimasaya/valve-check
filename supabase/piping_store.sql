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

grant usage on schema public to anon, authenticated;
grant select, insert, update on piping_store to anon, authenticated;

-- 既存テーブルと同じく、ログイン機能を作るまでの間は匿名キーからの読み書きを許可する。
alter table piping_store enable row level security;
drop policy if exists "demo: allow all on piping_store" on piping_store;
create policy "demo: allow all on piping_store" on piping_store for all using (true) with check (true);
