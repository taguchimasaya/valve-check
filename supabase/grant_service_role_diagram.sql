-- 系統図データのテーブルを、サーバー専用キー（service role）から読み書きできるようにする。
-- 使いみち：系統図の版を、Excel を通さずにスクリプト（.env.local のサーバー専用キー）で下書きとして登録するため。
-- SQL Editor で実行してください。何度実行しても問題ありません。
-- 既存の行・ほかのロール（anon・authenticated）の権限・RLS のポリシーは変えません。
-- service role は RLS を通らないため、このキーを持つサーバー・スクリプトは系統図のデータをすべて読み書きできます
-- （キーは Vercel の環境変数と .env.local にだけ置き、ブラウザには渡さないこと）。
--
-- 元に戻すとき：下の grant を revoke にして実行する
--   （例：revoke select, insert, update, delete on public.piping_nodes from service_role;）

grant usage on schema public to service_role;

do $$
declare
  t text;
  s text;
begin
  foreach t in array array[
    'piping_facilities', 'piping_diagram_versions', 'piping_source_documents', 'piping_sheets', 'piping_pipe_specs',
    'piping_areas', 'piping_nodes', 'piping_pipes', 'piping_node_symbols', 'piping_pipe_geometries',
    'piping_import_batches', 'piping_validation_issues'
  ] loop
    if to_regclass('public.' || t) is null then
      raise notice 'テーブル % がありません（飛ばします）', t;
      continue;
    end if;
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    -- 連番の列（id など）があれば、その連番も使えるようにする
    for s in
      select pg_get_serial_sequence('public.' || t, a.attname)
      from pg_attribute a
      where a.attrelid = ('public.' || t)::regclass and a.attnum > 0 and not a.attisdropped
        and pg_get_serial_sequence('public.' || t, a.attname) is not null
    loop
      execute format('grant usage, select on sequence %s to service_role', s);
    end loop;
  end loop;
end $$;
