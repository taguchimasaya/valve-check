-- 配管系統図データ：サンプリング装置（タンクの試料採取）の種別を加える
-- piping_diagram_v4.sql の後に、SQL Editor で実行してください。何度実行しても問題ありません。
-- 既存の行は変えません（種別の制約に 'sampler' を足すだけ）。

alter table piping_nodes drop constraint if exists piping_nodes_kind_check;
alter table piping_nodes add constraint piping_nodes_kind_check check (kind in (
  'junction', 'valve', 'check', 'tank', 'pump', 'transferPump', 'strainer', 'filter',
  'psv', 'drain', 'gauge', 'source', 'sink',
  'hydrant',       -- 消火栓（泡消火栓を含む）
  'monitor',       -- 放水銃・泡モニター
  'sprinkler',     -- 散水ヘッド・冷却散水設備
  'proportioner',  -- 泡混合器
  'foamChamber',   -- タンク発泡装置（固定泡放出口）
  'sampler'        -- サンプリング装置（タンクの試料採取。ドレンはドレンタンクへ）
));
