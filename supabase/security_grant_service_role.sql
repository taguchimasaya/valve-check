-- セキュリティ対策 その1（アプリの反映「前」に実行）
-- アプリの API（/api/piping）が、サーバー専用キー（service role）で piping_store を読み書きできるようにする。
-- これだけでは何も閉じない（利用者の権限は今のまま）ので、実行しても今の動きは変わりません。
-- Supabase ダッシュボード → SQL Editor で実行してください。何度実行しても安全です。

grant usage on schema public to service_role;
grant select, insert, update, delete on public.piping_store to service_role;

-- 確認：次の結果が true なら OK
select has_table_privilege('service_role', 'public.piping_store', 'select, insert, update') as service_role_can_use_piping_store;
