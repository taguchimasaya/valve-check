-- バルブ点検アプリ 初期データベーススキーマ
-- Supabaseダッシュボード → SQL Editor → New query に貼り付けて実行してください。

-- 機器マスター（バルブ等の設備台帳。既存保守管理システムからのインポート先）
create table if not exists equipment (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,          -- 機器番号（QRコードに埋め込む値）
  name text not null,                 -- 機器名称
  location text,                      -- 設置場所
  valve_type text,                    -- バルブ種別
  checklist_template_id uuid,         -- 適用するチェックリスト（後で設定）
  imported_at timestamptz not null default now()
);

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
create table if not exists inspection_results (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references inspection_sessions(id) on delete cascade,
  equipment_id uuid not null references equipment(id),
  item_id uuid not null references checklist_items(id),
  result text not null check (result in ('OK', 'NG')),
  comment text,
  checked_by text,
  checked_at timestamptz not null default now(),
  unique (session_id, equipment_id, item_id)
);

-- 制御室PC側のダッシュボードがリアルタイム更新を受け取れるようにする
alter publication supabase_realtime add table inspection_results;

-- --- デモ用の簡易アクセス許可 ---
-- 「Automatically expose new tables」をOFFにした場合に備え、テーブルへの
-- アクセス権をここで明示的に付与します（ONの場合でも実行して問題ありません）。
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  equipment, checklist_templates, checklist_items, inspection_sessions, inspection_results
  to anon, authenticated;

-- ログイン機能を作るまでの間、匿名キーからの読み書きを許可します。
-- 本運用前には行レベルセキュリティ(RLS)のポリシーを利用実態に合わせて見直してください。
alter table equipment enable row level security;
alter table checklist_templates enable row level security;
alter table checklist_items enable row level security;
alter table inspection_sessions enable row level security;
alter table inspection_results enable row level security;

create policy "demo: allow all on equipment" on equipment for all using (true) with check (true);
create policy "demo: allow all on checklist_templates" on checklist_templates for all using (true) with check (true);
create policy "demo: allow all on checklist_items" on checklist_items for all using (true) with check (true);
create policy "demo: allow all on inspection_sessions" on inspection_sessions for all using (true) with check (true);
create policy "demo: allow all on inspection_results" on inspection_results for all using (true) with check (true);
