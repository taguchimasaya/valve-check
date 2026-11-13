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
  created_at timestamptz not null default now(),
  current_checklist_template_id uuid references checklist_templates(id),
  current_item_id uuid references checklist_items(id)
);

-- 既存DBに対する追記分（初回セットアップ時にも実行して問題ありません）
alter table inspection_sessions add column if not exists current_checklist_template_id uuid;
alter table inspection_sessions add constraint inspection_sessions_template_fk foreign key (current_checklist_template_id) references checklist_templates(id) on delete set null;
alter table inspection_sessions add column if not exists current_item_id uuid;
alter table inspection_sessions add constraint inspection_sessions_item_fk foreign key (current_item_id) references checklist_items(id) on delete set null;

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

-- 工程が開始されたことを記録する（工程完了と開始を分離するため）。
-- 制御室が「次工程開始」通知を受け取るために使用。
create table if not exists step_start_notifications (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references inspection_sessions(id) on delete cascade,
  item_id uuid not null references checklist_items(id),
  item_name text not null,
  template_id uuid not null references checklist_templates(id),
  template_name text not null,
  started_at timestamptz not null default now(),
  unique (session_id, item_id)
);
alter publication supabase_realtime add table step_start_notifications;

-- --- デモ用の簡易アクセス許可 ---
-- 「Automatically expose new tables」をOFFにした場合に備え、テーブルへの
-- アクセス権をここで明示的に付与します（ONの場合でも実行して問題ありません）。
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  equipment, checklist_templates, checklist_items, checklist_item_equipment,
  inspection_sessions, inspection_results, step_notifications, step_start_notifications
  to anon, authenticated;

-- ログイン機能を作るまでの間、匿名キーからの読み書きを許可します。
-- 本運用前には行レベルセキュリティ(RLS)のポリシーを利用実態に合わせて見直してください。
alter table equipment enable row level security;
alter table checklist_templates enable row level security;
alter table checklist_items enable row level security;
alter table checklist_item_equipment enable row level security;
alter table inspection_sessions enable row level security;
alter table inspection_results enable row level security;
alter table step_notifications enable row level security;
alter table step_start_notifications enable row level security;

create policy "demo: allow all on equipment" on equipment for all using (true) with check (true);
create policy "demo: allow all on checklist_templates" on checklist_templates for all using (true) with check (true);
create policy "demo: allow all on checklist_items" on checklist_items for all using (true) with check (true);
create policy "demo: allow all on checklist_item_equipment" on checklist_item_equipment for all using (true) with check (true);
create policy "demo: allow all on inspection_sessions" on inspection_sessions for all using (true) with check (true);
create policy "demo: allow all on inspection_results" on inspection_results for all using (true) with check (true);
create policy "demo: allow all on step_notifications" on step_notifications for all using (true) with check (true);
create policy "demo: allow all on step_start_notifications" on step_start_notifications for all using (true) with check (true);

-- --- 配管系統図機能 ---
-- 抜取チェックリスト作成・図面での現場点検・制御室の保存先（1行のJSON）。
-- 単独で実行する場合は supabase/piping_store.sql を使用してください。
create table if not exists piping_store (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into piping_store (id) values ('main') on conflict (id) do nothing;
grant select, insert, update on piping_store to anon, authenticated;
alter table piping_store enable row level security;
create policy "demo: allow all on piping_store" on piping_store for all using (true) with check (true);

-- ───── 配管系統図データ（supabase/piping_diagram.sql と同じ内容） ─────

-- 施設（図面の大きさ・縮尺）
create table if not exists piping_facilities (
  id text primary key,                         -- 施設ID（例: virtual-airport）
  name text not null,                          -- 施設名
  width numeric not null,                      -- 図面の座標範囲（横）
  height numeric not null,                     -- 図面の座標範囲（縦）
  meters_per_px numeric not null,              -- 縮尺（座標1あたりの実長 m）。配管の実長が空欄のときの概算に使う
  created_at timestamptz not null default now()
);

-- 系統図の版。設備更新のたびに新しい版を作り、使用中（active）は施設ごとに1つだけ。
-- チェックリスト・点検記録は作成時の版を参照するため、過去の版は消さずに retired にする。
create table if not exists piping_diagram_versions (
  id text primary key,                         -- 版ID（例: virtual-airport-v1）
  facility_id text not null references piping_facilities(id) on delete cascade,
  version_no integer not null,                 -- 版番号（1, 2, …）
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  note text,                                   -- 変更内容（例: P-13 更新に伴う配管変更）
  effective_from date,                         -- 使用開始日
  created_by text,
  created_at timestamptz not null default now(),
  unique (facility_id, version_no)
);
create unique index if not exists piping_diagram_versions_one_active
  on piping_diagram_versions (facility_id) where status = 'active';

-- 区画（受入系統A、第1ヤード など。図面の枠・運用停止範囲の単位）
create table if not exists piping_diagram_areas (
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  name text not null,
  x numeric not null,
  y numeric not null,
  w numeric not null,
  h numeric not null,
  sort integer not null default 0,
  primary key (version_id, name)
);

-- 機器（ノード）：バルブ・ポンプ・タンク・分岐点など
create table if not exists piping_diagram_nodes (
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  code text not null,                          -- 機器番号（QR・チェックリストの番号。版をまたいで同じ機器は同じ番号）
  kind text not null check (kind in (
    'junction', 'valve', 'check', 'tank', 'pump', 'transferPump', 'strainer', 'filter',
    'psv', 'drain', 'gauge', 'source', 'sink'
  )),
  label text not null default '',              -- 図面上の表示（分岐点は空）
  name text not null,                          -- 名称
  area text not null,                          -- 区画名
  x numeric not null,
  y numeric not null,
  normal text check (normal in ('open', 'close')),   -- 待機時の状態（弁・ドレン弁・圧力計元弁）
  volume_l numeric,                            -- 機器内容量（L）
  drain_size_a integer,                        -- ドレン口径（A）
  gauge_mountable boolean,                     -- 圧力計を取り付けられる
  service boolean,                             -- 作業用の弁（運用経路では通らない）
  fill_line boolean,                           -- 充填ライン上の弁
  fill_source boolean,                         -- 充填の供給元（分岐点）
  drain_pump_lpm numeric,                      -- 固定の抜取ポンプ能力（L/min）
  drain_route text[],                          -- 抜取用配管：開ける弁の順（ドレン弁 → 抜取ポンプ側）
  drain_target text,                           -- 抜取用配管：回収先（機器番号）
  drain_system text,                           -- 共有する抜取ポンプ（機器番号）
  dir_from text,                               -- 上流側の機器番号（逆止弁・ポンプ・安全弁の向き）
  small boolean,                               -- 小型タンク（メンテ用など）
  recovery boolean,                            -- 回収タンク（安全弁の逃がし先）
  compact boolean,                             -- 図面でラベルを省略
  capacity_kl numeric,                         -- タンク容量（kL）
  set_pressure_mpa numeric,                    -- 安全弁の設定圧力（MPa）
  equipment_code text,                         -- 既存の機器マスター（equipment.code）との対応（任意）
  sort integer not null default 0,
  primary key (version_id, code)
);

-- 配管：機器と機器の間を1本ずつ（分岐は分岐点で区切る）
create table if not exists piping_diagram_pipes (
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  code text not null,                          -- 配管番号（版をまたいで同じ配管は同じ番号）
  node_a text not null,                        -- 始点の機器番号
  node_b text not null,                        -- 終点の機器番号
  size_a integer not null,                     -- 呼び径（A）
  length_m numeric,                            -- 実長（m）。空欄なら図面上の長さ×縮尺
  via jsonb,                                   -- 経由点 [[x, y], …]（直角に曲げて描く）
  sort integer not null default 0,
  primary key (version_id, code),
  foreign key (version_id, node_a) references piping_diagram_nodes(version_id, code) on delete cascade,
  foreign key (version_id, node_b) references piping_diagram_nodes(version_id, code) on delete cascade
);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  piping_facilities, piping_diagram_versions, piping_diagram_areas, piping_diagram_nodes, piping_diagram_pipes
  to anon, authenticated;

-- 既存テーブルと同じく、ログイン機能を作るまでの間は匿名キーからの読み書きを許可する。
alter table piping_facilities enable row level security;
alter table piping_diagram_versions enable row level security;
alter table piping_diagram_areas enable row level security;
alter table piping_diagram_nodes enable row level security;
alter table piping_diagram_pipes enable row level security;
drop policy if exists "demo: allow all on piping_facilities" on piping_facilities;
create policy "demo: allow all on piping_facilities" on piping_facilities for all using (true) with check (true);
drop policy if exists "demo: allow all on piping_diagram_versions" on piping_diagram_versions;
create policy "demo: allow all on piping_diagram_versions" on piping_diagram_versions for all using (true) with check (true);
drop policy if exists "demo: allow all on piping_diagram_areas" on piping_diagram_areas;
create policy "demo: allow all on piping_diagram_areas" on piping_diagram_areas for all using (true) with check (true);
drop policy if exists "demo: allow all on piping_diagram_nodes" on piping_diagram_nodes;
create policy "demo: allow all on piping_diagram_nodes" on piping_diagram_nodes for all using (true) with check (true);
drop policy if exists "demo: allow all on piping_diagram_pipes" on piping_diagram_pipes;
create policy "demo: allow all on piping_diagram_pipes" on piping_diagram_pipes for all using (true) with check (true);
