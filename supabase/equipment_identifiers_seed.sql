-- デモ用の暫定管理番号（NFC タグ 10 枚）の初期データです。
-- 注意：これらは設備には割り当てません（equipment_code は null）。
--       設備への紐付けは QR 発行画面（/piping/qr）で行ってください。
-- 実行順：equipment_identifiers.sql を実行した後にこのファイルを実行してください。
-- 何度実行しても安全です（冪等）。既に同じ UID、または同じ管理番号の有効タグがある行は追加しません。
-- UID は demo_nfc_tags.csv と同じ値です。

insert into equipment_identifiers (identifier_type, identifier_value, equipment_code, display_number, status, note, updated_by)
select 'NFC', v.uid, null, v.num, 'ACTIVE', 'デモ用タグ', '初期データ'
from (values
  (1,  '0448B51BD52A81'),
  (2,  '0449B51BD52A81'),
  (3,  '044AB51BD52A81'),
  (4,  '044BB51BD52A81'),
  (5,  '043FB51BD52A81'),
  (6,  '0442B51BD52A81'),
  (7,  '0443B51BD52A81'),
  (8,  '0437B51BD52A81'),
  (9,  '0438B51BD52A81'),
  (10, '0439B51BD52A81')
) as v(num, uid)
-- 有効な NFC タグの管理番号は部分一意インデックスで重複不可のため、
-- 同じ管理番号の有効タグが既にある場合は追加をスキップします（失敗させません）。
where not exists (
  select 1
  from equipment_identifiers e
  where e.identifier_type = 'NFC'
    and (
      e.identifier_value = v.uid
      or (e.status = 'ACTIVE' and e.display_number = v.num)
    )
)
on conflict (identifier_type, identifier_value) do nothing;
