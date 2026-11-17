-- 権限×機能の表（ロールごとに使える機能）を DB に置き、DB 側の制限（RLS）もその表で判断するようにします。
-- auth_roles_rls.sql・equipment_identifiers.sql の次の段階です（両方を実行済みであること）。
-- Supabase ダッシュボード → SQL Editor で実行してください。何度実行しても安全です（冪等）。
--
-- 表はアプリの「権限の設定」（/admin/roles、ユーザー管理・権限の設定の機能を持つ人）で変えます。
-- 未設定のあいだは下の既定の表（src/lib/roles.ts の DEFAULT_GRANTS と同じ）を使います。
--   機能：create 作成 / checklist 点検の実施 / qr QRコード・NFCタグ / approveLeader・approveManager・approveControl 承認の各段 /
--         control 制御室 / diagram 系統図データ管理 / rules 作成のルール / equipment 機器マスター / users ユーザー管理・権限の設定
--   管理者の users は外せません（誰も権限を直せなくなるのを防ぐため）。
--   外部ベンダー（vendor）には users を付けられません（2026-11-17 追加。ユーザー管理以外はすべて使える）。
--
-- 書き込みの制限（読み取りは今までどおりログイン利用者全員）：
--   checklist_templates ほか2表・inspection_sessions   点検の実施（checklist）
--   inspection_results・各種通知                       点検の実施・制御室（checklist / control）
--   piping_store                                      作成・点検・承認・制御室・ルール・系統図のどれか（操作ごとの確認は /api/piping）
--   piping_ の系統図データ                              系統図データ管理（diagram）
--   equipment                                         追加・削除は機器マスター、更新（QR 発行済みの記録）は QR・機器マスター
--   equipment_identifiers（NFC タグ）                  QR コード・NFC タグ（qr）・機器マスター
--   app_settings（この表）                             ユーザー管理・権限の設定（users）
--
-- 注意：権限（ロール）の変更はトークンの更新（最長1時間）までは DB 側に反映されませんが、
--       権限×機能の表の変更は DB が毎回この表を読むため、すぐ反映されます。
-- 元に戻すときは auth_roles_rls.sql と equipment_identifiers.sql をもう一度実行してください。

-- ───── 設定の表 ─────
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
grant select, insert, update on public.app_settings to authenticated;

-- 既定の権限×機能
create or replace function public.default_role_grants()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "worker":   ["create", "checklist", "qr"],
    "approver": ["checklist", "qr", "approveLeader"],
    "manager":  ["checklist", "qr", "approveManager"],
    "control":  ["control", "approveControl"],
    "vendor":   ["create", "checklist", "qr", "approveLeader", "approveManager", "approveControl", "control", "diagram", "rules", "equipment"],
    "admin":    ["checklist", "qr", "approveLeader", "approveManager", "approveControl", "control", "diagram", "rules", "equipment", "users"]
  }'::jsonb;
$$;

-- 今の権限×機能（保存が無い・そのロールの行が無いときは既定）。RLS の中から呼ぶので、表の RLS を通さずに読む
create or replace function public.role_grants()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.default_role_grants() || coalesce((select value from public.app_settings where key = 'role_grants'), '{}'::jsonb);
$$;

-- ログイン中の利用者が、その機能を使えるか（ロールのどれかに付いていれば可。管理者のユーザー管理は常に可）
create or replace function public.has_perm(wanted text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from unnest(public.app_roles()) as r(role)
    where ((public.role_grants() -> r.role) ? wanted and not (r.role = 'vendor' and wanted = 'users'))
       or (r.role = 'admin' and wanted = 'users')
  );
$$;

-- いずれかの機能を使えるか
create or replace function public.has_any_perm(wanted text[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from unnest(wanted) as w(p) where public.has_perm(w.p));
$$;

-- ───── 設定の表の RLS ─────
alter table public.app_settings enable row level security;
drop policy if exists "role: read app_settings" on public.app_settings;
create policy "role: read app_settings" on public.app_settings for select to authenticated using (true);
drop policy if exists "role: write app_settings" on public.app_settings;
create policy "role: write app_settings" on public.app_settings
  for all to authenticated using (public.has_perm('users')) with check (public.has_perm('users'));

-- ───── 各テーブルの書き込みを、機能で判断するように置き換える ─────
do $$
declare
  t text;
  w text;
  -- テーブル → 書き込みに必要な機能（どれか1つ）
  rules jsonb := jsonb_build_object(
    'checklist_templates', '{checklist}',
    'checklist_items', '{checklist}',
    'checklist_item_equipment', '{checklist}',
    'inspection_sessions', '{checklist}',
    'inspection_results', '{checklist,control}',
    'step_notifications', '{checklist,control}',
    'step_start_notifications', '{checklist,control}',
    'inspection_start_notifications', '{checklist,control}',
    'piping_store', '{create,checklist,approveLeader,approveManager,approveControl,control,rules,diagram}',
    'piping_facilities', '{diagram}',
    'piping_diagram_versions', '{diagram}',
    'piping_diagram_areas', '{diagram}',
    'piping_diagram_nodes', '{diagram}',
    'piping_diagram_pipes', '{diagram}',
    'piping_source_documents', '{diagram}',
    'piping_sheets', '{diagram}',
    'piping_pipe_specs', '{diagram}',
    'piping_nodes', '{diagram}',
    'piping_pipes', '{diagram}',
    'piping_node_symbols', '{diagram}',
    'piping_pipe_geometries', '{diagram}',
    'piping_areas', '{diagram}',
    'piping_import_batches', '{diagram}',
    'piping_validation_issues', '{diagram}'
  );
begin
  for t, w in select key, value #>> '{}' from jsonb_each(rules) loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', 'role: write ' || t, t);
    execute format(
      'create policy %I on %I for all to authenticated using (public.has_any_perm(%L)) with check (public.has_any_perm(%L))',
      'role: write ' || t, t, w, w
    );
  end loop;

  if to_regclass('public.equipment') is not null then
    drop policy if exists "role: insert equipment" on public.equipment;
    drop policy if exists "role: delete equipment" on public.equipment;
    drop policy if exists "role: update equipment" on public.equipment;
    create policy "role: insert equipment" on public.equipment for insert to authenticated with check (public.has_perm('equipment'));
    create policy "role: delete equipment" on public.equipment for delete to authenticated using (public.has_perm('equipment'));
    create policy "role: update equipment" on public.equipment for update to authenticated
      using (public.has_any_perm('{qr,equipment}')) with check (public.has_any_perm('{qr,equipment}'));
  end if;

  if to_regclass('public.equipment_identifiers') is not null then
    drop policy if exists "role: insert equipment_identifiers" on public.equipment_identifiers;
    drop policy if exists "role: update equipment_identifiers" on public.equipment_identifiers;
    create policy "role: insert equipment_identifiers" on public.equipment_identifiers
      for insert to authenticated with check (public.has_any_perm('{qr,equipment}'));
    create policy "role: update equipment_identifiers" on public.equipment_identifiers
      for update to authenticated using (public.has_any_perm('{qr,equipment}')) with check (public.has_any_perm('{qr,equipment}'));
  end if;
end $$;
