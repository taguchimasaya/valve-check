-- 配管系統図データ（本番想定の構造）
-- Supabaseダッシュボード → SQL Editor → New query に貼り付けて実行してください。何度実行しても問題ありません。
--
-- 考え方：
--   ・「論理データ」（機器・つながり・諸元。計算に使う）と「図面データ」（図面シートごとの座標・配管の描き方）を分ける。
--     → 座標が無くても計算はでき、CAD・PDF・手作業のどれで座標を作っても論理データは同じ。
--   ・実施設の系統図は複数枚の図面にまたがるため、座標は「図面シート」ごとに持つ。
--   ・配管の内径は呼び径・スケジュール別の配管仕様マスターから引く（プログラムの固定値を使わない）。
--   ・どの図面・どの取込でデータを作ったか（出典）と、入力チェックの結果を残す。
-- 既存のテーブル（equipment / checklist_* / inspection_* / piping_store）には一切変更を加えません。
-- 第1版のテーブル（piping_diagram_nodes など）にデータがあれば、最後に新しいテーブルへ移します（第1版のテーブルは残ります）。

-- ───── 施設・版（第1版から継続） ─────
create table if not exists piping_facilities (
  id text primary key,
  name text not null,
  width numeric not null,
  height numeric not null,
  meters_per_px numeric not null,
  created_at timestamptz not null default now()
);

create table if not exists piping_diagram_versions (
  id text primary key,
  facility_id text not null references piping_facilities(id) on delete cascade,
  version_no integer not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  note text,
  effective_from date,
  created_by text,
  created_at timestamptz not null default now(),
  unique (facility_id, version_no)
);
create unique index if not exists piping_diagram_versions_one_active
  on piping_diagram_versions (facility_id) where status = 'active';

-- ───── 出典（元の図面ファイル） ─────
create table if not exists piping_source_documents (
  id text primary key,                         -- 例: VA-P&ID-001-R3
  facility_id text not null references piping_facilities(id) on delete cascade,
  doc_no text not null,                        -- 図面番号
  title text not null,                         -- 図面名称
  revision text,                               -- 改訂記号
  file_type text not null check (file_type in ('dwg', 'dxf', 'pdf_vector', 'pdf_scan', 'paper', 'excel', 'other')),
  file_name text,
  note text,
  created_at timestamptz not null default now()
);

-- ───── 図面シート（座標の基準。1版に複数枚） ─────
create table if not exists piping_sheets (
  id text primary key,                         -- 例: virtual-airport-v1-S1
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  sheet_no text not null,                      -- 例: S1
  title text not null,
  source_document_id text references piping_source_documents(id) on delete set null,
  width numeric not null,                      -- 座標の範囲（CADなら図面の単位、PDFならポイント）
  height numeric not null,
  meters_per_unit numeric,                     -- 縮尺（座標1あたりの実長 m）。系統図（スケルトン）で縮尺が無ければ空欄
  sort integer not null default 0,
  unique (version_id, sheet_no)
);

-- ───── 配管仕様マスター（呼び径・スケジュール → 内径） ─────
create table if not exists piping_pipe_specs (
  id text primary key,                         -- 例: 150A-Sch40
  size_a integer not null,
  schedule text not null,                      -- 例: Sch40、Sch20S
  outer_diameter_mm numeric not null,
  inner_diameter_mm numeric not null,
  material text,                               -- 例: SGP、STPG370、SUS304
  note text,
  unique (size_a, schedule, material)
);

-- ───── 区画（受入系統A、第1ヤード など） ─────
create table if not exists piping_areas (
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  name text not null,
  sheet_id text references piping_sheets(id) on delete cascade,   -- 枠を描くシート（枠が無ければ空欄）
  x numeric, y numeric, w numeric, h numeric,
  sort integer not null default 0,
  primary key (version_id, name)
);

-- ───── 機器（論理データ：計算に使う諸元。座標は持たない） ─────
create table if not exists piping_nodes (
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  code text not null,                          -- 機器番号（版をまたいで同じ機器は同じ番号。QR・チェックリストの番号）
  kind text not null check (kind in (
    'junction', 'valve', 'check', 'tank', 'pump', 'transferPump', 'strainer', 'filter',
    'psv', 'drain', 'gauge', 'source', 'sink'
  )),
  label text not null default '',              -- 図面上の表示（分岐点は空）
  name text not null,
  area text not null,                          -- 区画名
  equipment_code text,                         -- 既存の機器マスター（equipment.code）との対応
  normal text check (normal in ('open', 'close')),   -- 待機時の状態
  volume_l numeric,                            -- 機器内容量（L）
  drain_size_a integer,
  gauge_mountable boolean,
  service boolean,
  fill_line boolean,
  fill_source boolean,
  drain_pump_lpm numeric,
  drain_route text[],
  drain_target text,
  drain_system text,
  dir_from text,                               -- 上流側の機器番号（逆止弁・ポンプ・安全弁の向き）
  small boolean,
  recovery boolean,
  rated_flow_lpm numeric,                      -- ポンプの定格流量（L/min）
  capacity_kl numeric,
  set_pressure_mpa numeric,
  data_source text,                            -- 諸元の出典（例: 機器台帳、メーカー資料、現地確認）
  note text,
  sort integer not null default 0,
  primary key (version_id, code)
);

-- ───── 配管（論理データ：つながり・呼び径・実長） ─────
create table if not exists piping_pipes (
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  code text not null,                          -- 配管番号（版をまたいで同じ配管は同じ番号）
  line_no text,                                -- 配管ライン番号（例: 150-JA-1001）
  node_a text not null,
  node_b text not null,
  size_a integer not null,
  pipe_spec_id text references piping_pipe_specs(id),   -- 空欄なら呼び径の Sch40 相当で計算
  length_m numeric,                            -- 実長（m）
  length_source text check (length_source in ('measured', 'isometric', 'cad', 'drawing_estimate')),
  note text,
  sort integer not null default 0,
  primary key (version_id, code),
  foreign key (version_id, node_a) references piping_nodes(version_id, code) on delete cascade,
  foreign key (version_id, node_b) references piping_nodes(version_id, code) on delete cascade
);

-- ───── 図面データ：機器の記号の位置（シートごと。1つの機器が複数シートに出てもよい） ─────
create table if not exists piping_node_symbols (
  version_id text not null,
  node_code text not null,
  sheet_id text not null references piping_sheets(id) on delete cascade,
  x numeric not null,
  y numeric not null,
  rotation numeric not null default 0,         -- 記号の向き（度）
  show_label boolean not null default true,    -- 図面でラベルを出すか
  primary key (version_id, node_code, sheet_id),
  foreign key (version_id, node_code) references piping_nodes(version_id, code) on delete cascade
);

-- ───── 図面データ：配管の描き方（シートごとの経由点） ─────
create table if not exists piping_pipe_geometries (
  version_id text not null,
  pipe_code text not null,
  sheet_id text not null references piping_sheets(id) on delete cascade,
  points jsonb,                                -- 両端の機器の間の経由点 [[x, y], …]
  primary key (version_id, pipe_code, sheet_id),
  foreign key (version_id, pipe_code) references piping_pipes(version_id, code) on delete cascade
);

-- ───── 取込の記録と入力チェックの結果 ─────
create table if not exists piping_import_batches (
  id uuid primary key default gen_random_uuid(),
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  source_document_id text references piping_source_documents(id) on delete set null,
  method text not null check (method in ('dxf', 'pdf_text', 'manual', 'excel', 'migration')),
  summary jsonb,                               -- 件数・警告など
  imported_by text,
  imported_at timestamptz not null default now()
);

create table if not exists piping_validation_issues (
  id uuid primary key default gen_random_uuid(),
  version_id text not null references piping_diagram_versions(id) on delete cascade,
  severity text not null check (severity in ('error', 'warning')),
  target_type text not null check (target_type in ('node', 'pipe', 'sheet', 'version')),
  target_code text,
  message text not null,                       -- 例: どの配管にもつながっていない機器、逆止弁の向き未設定
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ───── 配管仕様マスター（JIS G 3454 STPG370 Sch40 の外径・内径） ─────
insert into piping_pipe_specs (id, size_a, schedule, outer_diameter_mm, inner_diameter_mm, material, note) values
  ('25A-Sch40', 25, 'Sch40', 34.0, 26.6, 'STPG370', null),
  ('40A-Sch40', 40, 'Sch40', 48.6, 40.9, 'STPG370', null),
  ('50A-Sch40', 50, 'Sch40', 60.5, 52.7, 'STPG370', null),
  ('80A-Sch40', 80, 'Sch40', 89.1, 78.1, 'STPG370', null),
  ('100A-Sch40', 100, 'Sch40', 114.3, 102.3, 'STPG370', null),
  ('150A-Sch40', 150, 'Sch40', 165.2, 154.1, 'STPG370', null),
  ('200A-Sch40', 200, 'Sch40', 216.3, 202.7, 'STPG370', null),
  ('250A-Sch40', 250, 'Sch40', 267.4, 254.5, 'STPG370', null),
  ('300A-Sch40', 300, 'Sch40', 318.5, 304.8, 'STPG370', null)
on conflict (id) do nothing;

-- ───── 権限（既存テーブルと同じく、ログイン機能を作るまでは匿名キーからの読み書きを許可） ─────
grant usage on schema public to anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array[
    'piping_facilities', 'piping_diagram_versions', 'piping_source_documents', 'piping_sheets', 'piping_pipe_specs',
    'piping_areas', 'piping_nodes', 'piping_pipes', 'piping_node_symbols', 'piping_pipe_geometries',
    'piping_import_batches', 'piping_validation_issues'
  ] loop
    execute format('grant select, insert, update, delete on %I to anon, authenticated', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "demo: allow all on %s" on %I', t, t);
    execute format('create policy "demo: allow all on %s" on %I for all using (true) with check (true)', t, t);
  end loop;
end $$;

-- ───── 第1版のテーブルからの移行（piping_diagram_nodes などにデータがある版だけ。入れ直しても同じ結果） ─────
do $$
begin
  if to_regclass('public.piping_diagram_nodes') is null then
    return;
  end if;

  -- 移行する版：第1版の表に機器がある版
  drop table if exists _mig;
  create temporary table _mig as
    select distinct v.id as version_id, v.facility_id, f.width, f.height, f.meters_per_px
    from piping_diagram_versions v
    join piping_facilities f on f.id = v.facility_id
    where exists (select 1 from piping_diagram_nodes n where n.version_id = v.id);

  delete from piping_validation_issues where version_id in (select version_id from _mig);
  delete from piping_import_batches where version_id in (select version_id from _mig) and method = 'migration';
  delete from piping_pipe_geometries where version_id in (select version_id from _mig);
  delete from piping_node_symbols where version_id in (select version_id from _mig);
  delete from piping_pipes where version_id in (select version_id from _mig);
  delete from piping_nodes where version_id in (select version_id from _mig);
  delete from piping_areas where version_id in (select version_id from _mig);
  delete from piping_sheets where version_id in (select version_id from _mig);

  -- 試作は1枚の全体系統図（座標はプログラムで作った仮のもの）
  insert into piping_source_documents (id, facility_id, doc_no, title, revision, file_type, note)
    select distinct m.facility_id || '-SAMPLE', m.facility_id, 'SAMPLE', '試作の仮想施設（プログラムで作図）', '1', 'other', 'サンプルデータ'
    from _mig m
  on conflict (id) do nothing;

  insert into piping_sheets (id, version_id, sheet_no, title, source_document_id, width, height, meters_per_unit, sort)
    select m.version_id || '-S1', m.version_id, 'S1', '全体系統図', m.facility_id || '-SAMPLE', m.width, m.height, m.meters_per_px, 0
    from _mig m;

  insert into piping_areas (version_id, name, sheet_id, x, y, w, h, sort)
    select a.version_id, a.name, a.version_id || '-S1', a.x, a.y, a.w, a.h, a.sort
    from piping_diagram_areas a join _mig m on m.version_id = a.version_id;

  insert into piping_nodes (
    version_id, code, kind, label, name, area, equipment_code, normal, volume_l, drain_size_a, gauge_mountable,
    service, fill_line, fill_source, drain_pump_lpm, drain_route, drain_target, drain_system, dir_from, small,
    recovery, capacity_kl, set_pressure_mpa, data_source, sort)
    select n.version_id, n.code, n.kind, n.label, n.name, n.area, n.equipment_code, n.normal, n.volume_l, n.drain_size_a,
      n.gauge_mountable, n.service, n.fill_line, n.fill_source, n.drain_pump_lpm, n.drain_route, n.drain_target,
      n.drain_system, n.dir_from, n.small, n.recovery, n.capacity_kl, n.set_pressure_mpa, 'サンプル（仮の値）', n.sort
    from piping_diagram_nodes n join _mig m on m.version_id = n.version_id;

  insert into piping_node_symbols (version_id, node_code, sheet_id, x, y, rotation, show_label)
    select n.version_id, n.code, n.version_id || '-S1', n.x, n.y, 0, not coalesce(n.compact, false)
    from piping_diagram_nodes n join _mig m on m.version_id = n.version_id;

  insert into piping_pipes (version_id, code, node_a, node_b, size_a, pipe_spec_id, length_m, length_source, sort)
    select p.version_id, p.code, p.node_a, p.node_b, p.size_a,
      (select s.id from piping_pipe_specs s where s.id = p.size_a || 'A-Sch40'),
      p.length_m, case when p.length_m is null then 'drawing_estimate' else 'measured' end, p.sort
    from piping_diagram_pipes p join _mig m on m.version_id = p.version_id;

  insert into piping_pipe_geometries (version_id, pipe_code, sheet_id, points)
    select p.version_id, p.code, p.version_id || '-S1', p.via
    from piping_diagram_pipes p join _mig m on m.version_id = p.version_id;

  insert into piping_import_batches (version_id, source_document_id, method, summary, imported_by)
    select m.version_id, m.facility_id || '-SAMPLE', 'migration',
      jsonb_build_object(
        'nodes', (select count(*) from piping_nodes n where n.version_id = m.version_id),
        'pipes', (select count(*) from piping_pipes p where p.version_id = m.version_id)),
      '第1版テーブルからの移行'
    from _mig m;
end $$;
