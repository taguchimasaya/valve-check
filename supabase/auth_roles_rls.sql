-- 権限（ロール）による DB の読み書きの制限。auth_rls.sql（ログイン利用者だけ）の次の段階です。
--
-- 権限はアプリのユーザー管理（/admin/users）で付け、Supabase Auth の app_metadata.roles に保存されます。
-- ログインのトークン（JWT）に入るため、DB 側では auth.jwt() で読めます。未設定の利用者は作業者として扱います。
--   worker 作業者 / approver チームリーダー / manager G長 / control 制御室 / admin 管理者（すべて）
--   2026-11-15：G長（manager）を追加。作業者・チームリーダーと同じ表に書き込める（承認は piping_store に保存）
--
-- 読み取り：ログイン中の利用者は全員読める（今までどおり）
-- 書き込み：
--   equipment                         追加・削除は管理者、更新（QR 発行済みの記録）は作業者・チームリーダー・G長・管理者
--   checklist_templates ほか2表       作業者・チームリーダー・G長・管理者（チェックリスト取込）
--   inspection_sessions               作業者・チームリーダー・G長・管理者
--   inspection_results・各種通知      作業者・チームリーダー・G長・制御室・管理者（現場の記録と制御室の確認）
--   piping_store                      権限のある全員（操作ごとの確認は /api/piping が行う）
--   piping_ の系統図データ            管理者（④ 系統図データ管理・系統図エディタ）
--
-- 実行の前に：
--   1. アプリを本番に反映し、ユーザー管理で全員の権限を設定しておくこと
--      （ADMIN_LOGIN_IDS の管理者は /api/me を開いたときに app_metadata にも管理者が書き込まれる）
--   2. 権限の変更はトークンの更新（最長1時間）までは DB 側に反映されない
-- 存在しないテーブルは飛ばすので、何度実行しても問題ありません。元に戻すときは auth_rls.sql を実行してください。

-- ログイン中の利用者の権限（未設定なら作業者）
create or replace function public.app_roles()
returns text[]
language sql
stable
set search_path = ''
as $$
  select case
    when jsonb_typeof(auth.jwt() -> 'app_metadata' -> 'roles') = 'array'
      then array(select jsonb_array_elements_text(auth.jwt() -> 'app_metadata' -> 'roles'))
    else array['worker']
  end;
$$;

-- いずれかの権限を持っているか
create or replace function public.has_any_role(wanted text[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select 'admin' = any(public.app_roles()) or public.app_roles() && wanted;
$$;

do $$
declare
  t text;
  w text;
  -- テーブル → 書き込みに必要な権限（admin は常に可）
  rules jsonb := jsonb_build_object(
    'checklist_templates', '{worker,approver,manager}',
    'checklist_items', '{worker,approver,manager}',
    'checklist_item_equipment', '{worker,approver,manager}',
    'inspection_sessions', '{worker,approver,manager}',
    'inspection_results', '{worker,approver,manager,control}',
    'step_notifications', '{worker,approver,manager,control}',
    'step_start_notifications', '{worker,approver,manager,control}',
    'inspection_start_notifications', '{worker,approver,manager,control}',
    'piping_store', '{worker,approver,manager,control}',
    'piping_facilities', '{}',
    'piping_diagram_versions', '{}',
    'piping_diagram_areas', '{}',
    'piping_diagram_nodes', '{}',
    'piping_diagram_pipes', '{}',
    'piping_source_documents', '{}',
    'piping_sheets', '{}',
    'piping_pipe_specs', '{}',
    'piping_nodes', '{}',
    'piping_pipes', '{}',
    'piping_node_symbols', '{}',
    'piping_pipe_geometries', '{}',
    'piping_areas', '{}',
    'piping_import_batches', '{}',
    'piping_validation_issues', '{}'
  );
begin
  for t, w in select key, value #>> '{}' from jsonb_each(rules) union all select 'equipment', null loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('alter table %I enable row level security', t);
    -- これまでのポリシー（誰でも／ログイン利用者なら全部）を外す
    execute format('drop policy if exists %I on %I', 'demo: allow all on ' || t, t);
    execute format('drop policy if exists %I on %I', 'logged in: all on ' || t, t);
    execute format('drop policy if exists %I on %I', 'role: read ' || t, t);
    execute format('drop policy if exists %I on %I', 'role: write ' || t, t);
    execute format('drop policy if exists %I on %I', 'role: insert ' || t, t);
    execute format('drop policy if exists %I on %I', 'role: update ' || t, t);
    execute format('drop policy if exists %I on %I', 'role: delete ' || t, t);
    execute format('create policy %I on %I for select to authenticated using (true)', 'role: read ' || t, t);
    if t = 'equipment' then
      execute format('create policy %I on %I for insert to authenticated with check (public.has_any_role(%L))', 'role: insert ' || t, t, '{}');
      execute format('create policy %I on %I for delete to authenticated using (public.has_any_role(%L))', 'role: delete ' || t, t, '{}');
      execute format(
        'create policy %I on %I for update to authenticated using (public.has_any_role(%L)) with check (public.has_any_role(%L))',
        'role: update ' || t, t, '{worker,approver,manager}', '{worker,approver,manager}'
      );
    else
      execute format(
        'create policy %I on %I for all to authenticated using (public.has_any_role(%L)) with check (public.has_any_role(%L))',
        'role: write ' || t, t, w, w
      );
    end if;
  end loop;
end $$;
