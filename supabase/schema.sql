-- バルブ点検アプリ 初期データベーススキーマ
-- Supabaseダッシュボード → SQL Editor → New query に貼り付けて実行してください。

-- 機器マスター（バルブ等の設備台帳。既存保守管理システムからのインポート先）
create table if not exists equipment (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,          -- 機器番号（QRコードに埋め込む値）
  name text not null,                 -- 機器名称
  location text,                      -- 設置場所（旧形式。階層1〜4に置き換え中）
  hierarchy1 text,                    -- 階層1（例: 給油所名）
  hierarchy2 text,                    -- 階層2（例: 号棟）
  hierarchy3 text,                    -- 階層3（例: 階）
  hierarchy4 text,                    -- 階層4（例: 室・エリア）
  valve_type text,                    -- バルブ種別
  checklist_template_id uuid,         -- 適用するチェックリスト（後で設定）
  imported_at timestamptz not null default now(),
  qr_issued_at timestamptz            -- QRコードを発行済み（現場のバルブに貼付済み）にした日時
);

-- 既存DBに対する追記分（初回セットアップ時にも実行して問題ありません）
alter table equipment add column if not exists qr_issued_at timestamptz;
alter table equipment add column if not exists hierarchy1 text;
alter table equipment add column if not exists hierarchy2 text;
alter table equipment add column if not exists hierarchy3 text;
alter table equipment add column if not exists hierarchy4 text;

-- チェックリストのひな形（Excelチェックリストのインポート先）
create table if not exists checklist_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,                 -- チェックリスト名
  source_file text,                   -- 元のExcelファイル名
  created_at timestamptz not null default now()
);

-- チェックリストの各点検項目
create table if not exists checklist_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references checklist_templates(id) on delete cascade,
  item_no int not null,               -- 項目番号（表示順）
  item_name text not null,            -- 点検項目名
  criteria text,                      -- 判定基準
  unique (template_id, item_no)
);

alter table equipment
  add constraint equipment_checklist_template_fk
  foreign key (checklist_template_id) references checklist_templates(id);

-- 「バルブ×工程」手順チェックリスト用: どの工程(項目)でどのバルブの操作が
-- 必要かを表す。ここに存在しない組み合わせは「対象外（／）」として扱う。
create table if not exists checklist_item_equipment (
  item_id uuid not null references checklist_items(id) on delete cascade,
  equipment_id uuid not null references equipment(id) on delete cascade,
  target_state text check (target_state in ('open', 'close')), -- その工程でこのバルブが「開」「閉」どちらになる想定か
  primary key (item_id, equipment_id)
);

-- 既存DBに対する追記分（初回セットアップ時にも実行して問題ありません）
alter table checklist_item_equipment add column if not exists target_state text;
alter table checklist_item_equipment drop constraint if exists checklist_item_equipment_target_state_check;
alter table checklist_item_equipment add constraint checklist_item_equipment_target_state_check
  check (target_state in ('open', 'close'));

-- 点検セッション（1回の点検作業の単位）
create table if not exists inspection_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  session_date date not null default current_date,
  status text not null default 'in_progress', -- in_progress / completed
  created_by text,
  created_at timestamptz not null default now()
);

-- 点検結果（iPadでのQRスキャン→チェックの記録。制御室PCがここをリアルタイム購読する）
-- checked_at = 現場（操作者）がQRを読んでチェックした証跡
-- confirmed_at = 制御室が「確認」を押した証跡（現場と制御室、双方の記録を別々に残す）
create table if not exists inspection_results (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references inspection_sessions(id) on delete cascade,
  equipment_id uuid not null references equipment(id),
  item_id uuid not null references checklist_items(id),
  result text not null check (result in ('OK', 'NG', 'NA')),
  comment text,
  checked_by text,
  checked_at timestamptz not null default now(),
  confirmed_by text,
  confirmed_at timestamptz,
  unique (session_id, equipment_id, item_id)
);

-- 既存DBに対する追記分（初回セットアップ時にも実行して問題ありません）
alter table inspection_results add column if not exists confirmed_by text;
alter table inspection_results add column if not exists confirmed_at timestamptz;
alter table inspection_results drop constraint if exists inspection_results_result_check;
alter table inspection_results add constraint inspection_results_result_check
  check (result in ('OK', 'NG', 'NA'));

-- 制御室PC側のダッシュボードがリアルタイム更新を受け取れるようにする
alter publication supabase_realtime add table inspection_results;

-- ある工程の操作対象バルブが全てQRスキャンされた（＝工程完了）タイミングの記録。
-- 制御室ダッシュボードはこのテーブルをリアルタイム購読して通知を表示する。
create table if not exists step_notifications (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references inspection_sessions(id) on delete cascade,
  item_id uuid not null references checklist_items(id),
  item_name text not null,
  template_id uuid not null references checklist_templates(id),
  template_name text not null,
  notified_at timestamptz not null default now(),
  unique (session_id, item_id)
);
alter publication supabase_realtime add table step_notifications;

-- --- デモ用の簡易アクセス許可 ---
-- 「Automatically expose new tables」をOFFにした場合に備え、テーブルへの
-- アクセス権をここで明示的に付与します（ONの場合でも実行して問題ありません）。
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  equipment, checklist_templates, checklist_items, checklist_item_equipment,
  inspection_sessions, inspection_results, step_notifications
  to anon, authenticated;

-- ログイン機能を作るまでの間、匿名キーからの読み書きを許可します。
-- 本運用前には行レベルセキュリティ(RLS)のポリシーを利用実態に合わせて見直してください。
alter table equipment enable row level security;
alter table checklist_templates enable row level security;
alter table checklist_items enable row level security;
alter table checklist_item_equipment enable row level security;
alter table inspection_sessions enable row level security;
alter table inspection_results enable row level security;

create policy "demo: allow all on equipment" on equipment for all using (true) with check (true);
create policy "demo: allow all on checklist_templates" on checklist_templates for all using (true) with check (true);
create policy "demo: allow all on checklist_items" on checklist_items for all using (true) with check (true);
create policy "demo: allow all on checklist_item_equipment" on checklist_item_equipment for all using (true) with check (true);
create policy "demo: allow all on inspection_sessions" on inspection_sessions for all using (true) with check (true);
create policy "demo: allow all on inspection_results" on inspection_results for all using (true) with check (true);
