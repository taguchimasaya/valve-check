-- 配管系統図データ：消火設備と複数拠点への対応
-- 先に supabase/piping_diagram_v2.sql を実行してから、このファイルを SQL Editor で実行してください。何度実行しても問題ありません。
-- 既存のデータは変わりません（列を足し、機器の種別に消火設備を加えるだけ）。

-- ───── 機器の種別に消火設備を加える ─────
alter table piping_nodes drop constraint if exists piping_nodes_kind_check;
alter table piping_nodes add constraint piping_nodes_kind_check check (kind in (
  'junction', 'valve', 'check', 'tank', 'pump', 'transferPump', 'strainer', 'filter',
  'psv', 'drain', 'gauge', 'source', 'sink',
  'hydrant',       -- 消火栓
  'monitor',       -- 放水銃・泡モニター
  'sprinkler',     -- 散水ヘッド・スプリンクラー
  'proportioner'   -- 泡混合器
));

-- ───── 流体・系統 ─────
alter table piping_nodes add column if not exists fluid text;     -- 空欄＝燃料
alter table piping_nodes add column if not exists system text;    -- 系統名（例：燃料、消火）
alter table piping_pipes add column if not exists fluid text;     -- 空欄＝両端の機器の流体
alter table piping_nodes drop constraint if exists piping_nodes_fluid_check;
alter table piping_nodes add constraint piping_nodes_fluid_check check (fluid is null or fluid in ('fuel', 'water', 'foam', 'foamSolution', 'other'));
alter table piping_pipes drop constraint if exists piping_pipes_fluid_check;
alter table piping_pipes add constraint piping_pipes_fluid_check check (fluid is null or fluid in ('fuel', 'water', 'foam', 'foamSolution', 'other'));

-- ───── 拠点（施設）の表示順・メモ ─────
alter table piping_facilities add column if not exists sort integer not null default 0;
alter table piping_facilities add column if not exists note text;

-- 拠点ごとの点検・運用データは piping_store の行を拠点ごとに分けて持つ
-- （id = 'main' は仮想施設 virtual-airport、ほかの拠点は id = 施設ID の行。アプリが必要なときに作る）
