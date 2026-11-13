-- 配管系統図データ（施設・系統図の版・機器・配管・区画）のテーブル
-- Supabaseダッシュボード → SQL Editor → New query に貼り付けて実行してください。
-- 既存のテーブル（equipment / checklist_* / inspection_* / piping_store）には一切変更を加えません。
-- 何度実行しても問題ありません。サンプルデータは supabase/piping_diagram_seed.sql です。

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
