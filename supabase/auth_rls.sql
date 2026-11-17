-- ログイン（Supabase Auth）を入れたあと、DB をログイン中の利用者だけが読み書きできるようにする。
-- 今までの「demo: allow all ～」（誰でも読み書きできる）ポリシーを外し、
-- 「logged in: all ～」（authenticated のときだけ読み書きできる）ポリシーに置き換える。
-- 存在しないテーブルは飛ばすので、何度実行しても問題ありません。
-- 元に戻すときは、末尾のコメントの SQL を実行してください。

do $$
declare
  t text;
  tables text[] := array[
    -- 既存の点検機能
    'equipment', 'checklist_templates', 'checklist_items', 'checklist_item_equipment',
    'inspection_sessions', 'inspection_results', 'step_notifications', 'step_start_notifications',
    -- 配管系統図（piping_store は API だけが読み書きするため対象外：security_lockdown.sql）
    'piping_facilities', 'piping_diagram_versions', 'piping_diagram_areas', 'piping_diagram_nodes', 'piping_diagram_pipes',
    'piping_source_documents', 'piping_sheets', 'piping_pipe_specs', 'piping_nodes', 'piping_pipes',
    'piping_node_symbols', 'piping_pipe_geometries', 'piping_areas', 'piping_import_batches', 'piping_validation_issues'
  ];
begin
  foreach t in array tables loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', 'demo: allow all on ' || t, t);
    execute format('drop policy if exists %I on %I', 'logged in: all on ' || t, t);
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      'logged in: all on ' || t, t
    );
  end loop;
end $$;

-- 元に戻す（誰でも読み書きできる状態に戻す）とき：
-- do $$
-- declare t text;
-- begin
--   for t in select tablename from pg_policies where policyname like 'logged in: all on %' loop
--     execute format('drop policy if exists %I on %I', 'logged in: all on ' || t, t);
--     execute format('create policy %I on %I for all using (true) with check (true)', 'demo: allow all on ' || t, t);
--   end loop;
-- end $$;
