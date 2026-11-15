-- ログインID（メールアドレスの @ より前）から、ログインに使うメールアドレスを探す関数。
-- 例：test@test.com の利用者は、ログイン画面の ID に「test」と入れてログインできる。
-- @ より前が同じ利用者が複数いる場合は、どれか決められないため null を返す（メールアドレス全体でログインしてもらう）。
-- 何度実行しても問題ありません。

create or replace function public.login_email(login_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 1 then min(u.email)::text end
  from auth.users u
  where lower(split_part(u.email, '@', 1)) = lower(trim(login_id));
$$;

revoke all on function public.login_email(text) from public;
grant execute on function public.login_email(text) to anon, authenticated;
