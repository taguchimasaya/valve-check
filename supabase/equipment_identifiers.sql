-- 設備識別子（QR・NFC タグ）の管理テーブル。
-- Supabase ダッシュボード → SQL Editor で実行してください。何度実行しても安全です（冪等）。
--
-- 方針：
--   - 既存テーブル（equipment・点検履歴・piping_*）には一切変更を加えない。
--   - 紐付け先は機器番号（equipment_code）。QR の中身「/inspect/{機器番号}」と同じ値で、
--     既存系の equipment.code・配管系統図の機器ラベル（node.label）のどちらも指せる
--     （配管系統図の機器は equipment に無い場合があるため、外部キーは張らない）。
--   - QR は今までどおり機器番号そのものが識別値（このテーブルには行を作らない）。'QR' 種別は将来の拡張用。
--   - NFC は UID（7 バイト、16 進大文字、コロン無し。例 0439B51BD52A81）を識別値とする。
--     UID は暗号学的な認証情報ではない（複製・偽装の対策は対象外）。
--   - 1 枚のタグは常に 1 行。無効化しても行は消さない（タグ交換は旧タグを無効化 → 新タグを同じ機器番号に登録）。
--     点検履歴はタグを参照していないため、タグの無効化・付け替えで履歴は変わらない。
--
-- 読み取り：ログイン利用者全員。書き込み：QR 印刷の権限を持つ人（作業者・チームリーダー・G長）と管理者。
-- 権限の関数 public.has_any_role は auth_roles_rls.sql で作成済みのものを使う（先に実行しておくこと）。

create table if not exists equipment_identifiers (
  id uuid primary key default gen_random_uuid(),
  identifier_type text not null check (identifier_type in ('QR', 'NFC')),
  identifier_value text not null,      -- NFC は正規化済み UID
  equipment_code text,                 -- 紐付け先の機器番号（未割当は null）
  display_number int,                  -- タグの管理番号（人が識別するための番号。UID とは独立）
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint equipment_identifiers_type_value_key unique (identifier_type, identifier_value),
  constraint equipment_identifiers_nfc_uid_format check (identifier_type <> 'NFC' or identifier_value ~ '^[0-9A-F]{14}$'),
  constraint equipment_identifiers_code_not_blank check (equipment_code is null or btrim(equipment_code) <> '')
);

-- 有効な NFC タグは 1 機器につき 1 枚
create unique index if not exists equipment_identifiers_active_nfc_per_code
  on equipment_identifiers (equipment_code)
  where identifier_type = 'NFC' and status = 'ACTIVE' and equipment_code is not null;

-- 有効な NFC タグの管理番号は重複不可
create unique index if not exists equipment_identifiers_active_nfc_number
  on equipment_identifiers (display_number)
  where identifier_type = 'NFC' and status = 'ACTIVE' and display_number is not null;

create index if not exists equipment_identifiers_code_idx on equipment_identifiers (equipment_code);

-- updated_at の自動更新
create or replace function public.equipment_identifiers_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists equipment_identifiers_touch on equipment_identifiers;
create trigger equipment_identifiers_touch
  before update on equipment_identifiers
  for each row execute function public.equipment_identifiers_touch();

-- RLS（行単位のアクセス制御）
alter table equipment_identifiers enable row level security;
drop policy if exists "role: read equipment_identifiers" on equipment_identifiers;
create policy "role: read equipment_identifiers" on equipment_identifiers
  for select to authenticated using (true);
-- 削除のポリシーは作らない（タグは無効化で管理し、行は残す）
drop policy if exists "role: insert equipment_identifiers" on equipment_identifiers;
create policy "role: insert equipment_identifiers" on equipment_identifiers
  for insert to authenticated with check (public.has_any_role('{worker,approver,manager}'));
drop policy if exists "role: update equipment_identifiers" on equipment_identifiers;
create policy "role: update equipment_identifiers" on equipment_identifiers
  for update to authenticated
  using (public.has_any_role('{worker,approver,manager}'))
  with check (public.has_any_role('{worker,approver,manager}'));
