-- セキュリティ対策 その2（アプリの反映「後」に実行）
-- 前提：security_grant_service_role.sql を実行し、アプリ（2026-11-17 のセキュリティ対策の版）を本番に反映済みであること。
-- Supabase ダッシュボード → SQL Editor で実行してください。何度実行しても安全です。
--
-- 1. piping_store（チェックリスト・点検記録・運用入力など）を、利用者が直接読み書きできないようにする。
--    今までは作業者などが Supabase を直接呼んで piping_store を書き換えられ、アプリの確認
--    （承認フロー・本人だけの操作・管理者だけの削除・重複の防止・安全機構）をすり抜けられた。
--    読み書きはアプリの API がサーバー専用キーで行う（service role は RLS を通らない）。
-- 2. 権限（ロール）が未設定の利用者を「作業者」ではなく「権限なし」として扱う。
--    Supabase の新規登録で作られたアカウントが作業者として書き込めてしまうのを防ぐ。
--    （アプリ側も同じ変更をしている。本番の利用者は全員ロールが付いているため影響なし）
--
-- 元に戻すとき（緊急時）：auth_roles_rls.sql と role_grants.sql をこの対策より前の版で実行し直す。

-- ───── 1. piping_store は API だけ ─────
revoke all on public.piping_store from anon, authenticated;
grant select, insert, update, delete on public.piping_store to service_role;
alter table public.piping_store enable row level security;
do $$
declare
  p text;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'piping_store' loop
    execute format('drop policy if exists %I on public.piping_store', p);
  end loop;
end $$;

-- ───── 2. ロール未設定は権限なし ─────
create or replace function public.app_roles()
returns text[]
language sql
stable
set search_path = ''
as $$
  select case
    when jsonb_typeof(auth.jwt() -> 'app_metadata' -> 'roles') = 'array'
      then array(select jsonb_array_elements_text(auth.jwt() -> 'app_metadata' -> 'roles'))
    else array[]::text[]
  end;
$$;

-- 確認：利用者（authenticated）は piping_store を読めず（false）、サーバー専用キーは読める（true）
select
  has_table_privilege('authenticated', 'public.piping_store', 'select') as authenticated_can_read,
  has_table_privilege('service_role', 'public.piping_store', 'select') as service_role_can_read,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'piping_store') as policies_left;
