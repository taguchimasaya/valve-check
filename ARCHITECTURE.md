# ARCHITECTURE — システム構成・設計思想

バルブチェックリストシステム（バルブ点検アプリ）の構成と設計思想をまとめた資料です。
2026-11-15 時点のリポジトリ（main = `9f7a199`）・ソースコード・本番 Supabase の実データを調査して作成しました。
開発時はこの資料と [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)・[DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md) を参照してください。

> 補足：既存の `SYSTEM_ARCHITECTURE.md`（未コミット）は 2026-09 時点の内容で、認証・配管系統図機能が含まれていません。最新の構成は本書を正とします。

---

## 1. システムの全体像

このシステムは、燃料施設（空港給油施設・石油基地など）でのバルブ操作・点検を支援する Web アプリケーションです。2つの系統から成ります。

| 系統 | 画面 | 概要 |
|---|---|---|
| **A. 既存系（QRチェックリスト）** | `/equipment` `/equipment/print` `/checklists` `/inspect` `/inspect/[code]` `/control-room` `/settings` | 機器マスター（equipment）と Excel 取込のチェックリストを使い、現場 iPad の QR 読取で工程ごとに弁操作を記録し、制御室 PC がリアルタイム（Realtime）で監視する |
| **B. 配管系統図系（/piping）** | `/piping/planner` `/piping/field` `/piping/control`（運用停止範囲の設定を含む） `/piping/qr` `/piping/print`、管理設定（トップ右上）：`/piping/data`（`/piping/editor` を含む） `/piping/rules` | 配管系統図（グラフ構造）から遮断範囲・操作弁を自動算定してチェックリストを作り、図面上で現場点検・制御室監視を行う |

両系統はホーム画面（`/`）から入り、**ログイン（Supabase Auth）と権限（作業者・承認者・制御室・管理者）を共通**で使います。利用者は管理者がユーザー管理（`/admin/users`）で作ります。データは互いに独立しており、配管系統図系は既存系のテーブルに書き込みません（QR の形式 `/inspect/{code}` のみ共通）。

```
[iPad 現場] ─┐                         ┌─ Supabase Auth（ID・パスワード）
[制御室 PC] ─┼─ Next.js (Vercel) ──────┼─ Postgres（既存系テーブル：クライアントから直接）
[事務所 PC] ─┘   ├ App Router 画面     ├─ Realtime（既存系の通知・結果）
                 └ /api/piping/*  ─────┴─ Postgres（piping_* テーブル：API 経由）
```

## 2. 技術スタック

| 項目 | 内容 |
|---|---|
| フレームワーク（framework） | Next.js 16.3.4（App Router）※ 学習データと異なる破壊的変更あり。`AGENTS.md` の指示どおり `node_modules/next/dist/docs/` を確認してから実装すること |
| UI | React 19.2.8、Tailwind CSS 4 |
| BaaS | Supabase（`@supabase/supabase-js` 2.115）：Postgres・Auth・Realtime |
| QR | `html5-qrcode`（読取）、`qrcode.react`（生成） |
| NFC 読取 | ブラウザ標準の Web NFC（`NDEFReader`）。Android Chrome のみ対応。NDEF の中身は使わず、タグの UID（`serialNumber`）だけを使う（`src/lib/useNfcReader.ts`） |
| Excel | `xlsx` 0.18.5（取込・書出し） |
| メール | `nodemailer` 10（Gmail などの SMTP で承認フローのメールを送る） |
| 画面分割 | `react-rnd`（制御室の仮想デスクトップ） |
| 音声 | Web Audio API（ビープ音）・SpeechSynthesis（読み上げ） |
| ホスティング（hosting） | Vercel（main への push で自動デプロイ） |
| 定期実行 | GitHub Actions `keep-supabase-alive.yml`（無料プランの自動休止を防ぐ毎日 ping） |
| テスト | テストフレームワーク（test framework）は未導入。品質確認は `npx tsc --noEmit`・`npm run lint`・ブラウザでの動作確認 |

## 3. ディレクトリ構成

```
src/
  app/
    page.tsx, layout.tsx          ホーム・ルートレイアウト（AuthGate で全体を包む）
    login/                        ログイン画面（唯一の公開ページ）
    admin/users/                  ユーザー管理（管理者のみ。配管系統図トップの「⚙ 管理設定」とホームから開く）
    equipment/, equipment/print/  機器マスター・QR 印刷（既存系）
    checklists/                   チェックリスト取込（既存系）
    inspect/, inspect/[code]/     現場チェック（既存系、QR から直接開く画面を含む）
    control-room/                 制御室ダッシュボード（既存系、マルチモニター仮想デスクトップ）
    settings/                     音声・表示設定
    piping/                       配管系統図系（planner/field/control/data/rules/qr/print）
    api/piping/                   配管系統図系の API（route.ts、diagram/、diagram/versions/、facilities/）
    api/me/, api/admin/users/     ログイン中の利用者の権限・ユーザー管理の API
  components/
    AuthGate.tsx, UserBadge.tsx   ログイン必須化・ページごとの権限チェック・利用者と権限の表示
    NfcScanPanel.tsx              現場の NFC 読取パネル（/inspect・/piping/field）
    piping/                       系統図描画（PipingDiagram）・プレビュー・各種ピッカー・ルール編集
                                  NfcTagManager.tsx（/piping/qr の NFC タグ管理）
  lib/
    supabase.ts                   ブラウザ用 Supabase クライアント
    auth.ts                       ログイン・ログアウト・authFetch（Bearer トークン付き fetch）・useMe（自分の権限）
    roles.ts                      権限の定義（ロール→権限、ページごと・ストア操作ごとに必要な権限）
    serverAuth.ts                 API 側のトークン検証（requireAuth / requirePerm）、service role クライアント
    nfcUid.ts                     NFC の UID 正規化・検証・表示
    identifiers.ts                UID→機器番号の解決、タグの登録・交換（`equipment_identifiers`）
    useNfcReader.ts               Web NFC（NDEFReader）の読取フック
    inspectionSession.ts ほか     既存系のセッション・音声・弁操作判定・Excel 解析
    piping/                       配管系統図系のドメインロジック（下記 5 章）
supabase/                         SQL（SQL Editor で手動実行する。マイグレーションツールは未使用）
tools/piping-diagram/             サンプル系統図データ生成スクリプト（seed・第2拠点）
tools/tests/                      NFC の UID 正規化などの単体テスト（`node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs`）
.local-data/                      ローカル開発時の piping_store 保存先（git 管理外）
```

## 4. データベース（Supabase）

SQL は `supabase/` にあり、**ユーザーが Supabase ダッシュボードの SQL Editor で実行**する運用です（何度実行しても安全な冪等（idempotent）な書き方に統一）。

### 4.1 既存系テーブル（`schema.sql`）

| テーブル | 役割 |
|---|---|
| `equipment` | 機器（バルブ）マスター。`code` が QR の値 |
| `checklist_templates` / `checklist_items` / `checklist_item_equipment` | チェックリスト・工程・工程×機器の目標状態（open/close。行が無ければ対象外） |
| `inspection_sessions` | 点検セッション（現在の工程 `current_item_id` を持つ） |
| `inspection_results` | 点検結果（OK/NG/NA、制御室確認）。UNIQUE(session, equipment, item) で upsert |
| `step_notifications` / `step_start_notifications` | 工程完了・開始通知（Realtime で制御室へ） |

クライアント（ブラウザ）から Supabase に**直接**クエリします。Realtime（postgres_changes）で `/inspect` と `/control-room` を同期します。

### 4.2 配管系統図系テーブル

| テーブル | SQL | 役割 |
|---|---|---|
| `piping_store` | `piping_store.sql` | 拠点ごとに1行の JSON（チェックリスト・点検記録・運用入力・弁の手動変更・停止範囲・ルール）。`version` 列で楽観的排他（optimistic locking） |
| `piping_facilities` / `piping_diagram_versions` | `piping_diagram.sql`（v3 で列追加） | 拠点（施設）と系統図の版。版は `draft` → `active`（拠点ごとに1つ）→ `retired`。過去の版は消さない |
| `piping_diagram_areas` / `_nodes` / `_pipes` | `piping_diagram.sql` | 第1版の構造（座標を機器に直接持つ）。互換のため残置 |
| `piping_nodes` / `piping_pipes` / `piping_areas` | `piping_diagram_v2.sql` | **本番想定の論理データ**（機器・つながり・諸元。座標を持たない） |
| `piping_sheets` / `piping_node_symbols` / `piping_pipe_geometries` | 同上 | **図面データ**（図面シートごとの記号位置・配管経由点） |
| `piping_pipe_specs` | 同上 | 配管仕様マスター（呼び径・スケジュール → 内径。JIS G 3454 Sch40 を投入済み） |
| `piping_source_documents` / `piping_import_batches` / `piping_validation_issues` | 同上 | 出典図面・取込記録・入力チェック結果 |

v3（消火設備の種別・流体 `fluid`・系統 `system`・拠点の並び順）、v4（タンク発泡装置 `foamChamber`）で拡張しています。

### 4.3 認証・権限

- `auth_login_id.sql`：関数 `login_email(login_id)`（ID＝メールの @ より前 → メールアドレス）。**実行済み**。
- `auth_rls.sql`：`demo: allow all` ポリシーを `logged in: all`（authenticated のみ）に置き換える。**2026-11-15 本番実行済み**（ユーザー作業）。匿名キー（anon key）では読み取り 0 件・書き込み拒否になる。
- `auth_roles_rls.sql`：権限による書き込みの制限（読み取りはログイン利用者全員、書き込みはテーブルごとの権限。トークンの `app_metadata.roles` を見る）。**2026-11-15 本番実行済み**（`auth_rls.sql` の後にユーザーが実行）。テスト利用者4人で、権限ごとの書き込みの可否が下表どおりであることを確認済み。元に戻すときは `auth_rls.sql` を実行する。

#### チェックリストの承認フロー（`src/lib/piping/approval.ts`）

- 作成者（作業者）→ チームリーダー → G長 → 制御室。制御室の段は ⑤ 共通の設定（`rules.approval.requireControl`、拠点ごと、既定はあり）。
- ① の作成画面は「プレビュー → 承認依頼する」（`savePlan`。保存すると承認・差し戻しは外れて最初から）。作成しない人（チームリーダー・G長・制御室）が ① を開くと承認の画面（`ApprovalBoard`）だけになる。管理者は両方。
- 承認（`approvePlan`）は順番どおりの次の段だけ、その段の権限（管理者はどの段も）で、作成者本人は不可。差し戻し（`rejectPlan`）は承認フローのどれかの段の人が理由つきで行い、承認をすべて外す。差し戻し中は作成者が直して承認依頼し直すまで承認・差し戻しできない。点検の開始（`startExecution`）は最後の段まで承認されたものだけ。いずれも `/api/piping` で確かめる。
- 保存先は `piping_store` の `SavedPlan.approvals`（段ごとの `{by, byId, at}`）・`rejection`・`updatedById`（作成者の利用者 ID）。印刷の「作成・確認・承認・制御室」欄に名前が入る。
- メール通知（`src/lib/approvalMail.ts`）：⑤ 共通の「承認フローのメールを送る」（`rules.approval.notifyEmail`、既定はオフ）がオンの拠点で、承認依頼・各段の承認は次の段の権限を持つ人へ、差し戻しと最後の承認は作成者へ。宛先はユーザー管理の「通知先メール」（`user_metadata.notify_email`）。送信は Gmail などの SMTP（`SMTP_USER`・`SMTP_PASS`＝Gmail のアプリ パスワード、`SMTP_HOST` 既定 smtp.gmail.com・`SMTP_PORT` 既定 465。`nodemailer`）、無ければ Resend の API（`RESEND_API_KEY`）。送信元は `MAIL_FROM`。ユーザー管理の「テストメール」で設定を確かめられる。`/api/piping` の応答のあとに `after()` で送る（失敗しても操作は成功のまま）。

#### 権限（ロール）の設計

| 権限 | できること |
|---|---|
| 作業者 `worker` | チェックリストの作成と承認依頼（①、権限 `create`）・実施（② `/checklists` `/inspect`）、QR コード印刷（`/equipment/print` `/piping/qr`） |
| チームリーダー `approver` | 承認フローの1段目（① の承認画面）、② の実施・QR 印刷。作成はしない |
| G長 `manager` | 承認フローの2段目（① の承認画面）、② の実施・QR 印刷。作成はしない |
| 制御室 `control` | 承認フローの3段目（⑤ の設定で有無）、③ `/piping/control`（運用入力・弁の手動変更・運用停止範囲・現場記録の確認）、`/control-room` |
| 管理者 `admin` | すべて（`/admin/users`、④ `/piping/data` `/piping/editor`、⑤ `/piping/rules`、機器マスター `/equipment`） |

- **拠点ごとの権限**：作業者・チームリーダー・G長・制御室は拠点ごとに付ける（`app_metadata.siteRoles` = `{ 拠点ID: 権限[] }`。拠点ごとに担当者が違うため）。管理者だけは全拠点共通（`roles` の `admin`）。`roles` には全拠点を合わせた権限も入れ、拠点の区別が無い既存系の画面と DB 側の RLS はこれを使う。`siteRoles` が未設定の利用者は `roles` が全拠点に効く。配管系統図の画面・API は選択中の拠点での権限（`rolesAt()`）で判断し、権限の無い拠点は拠点の一覧にも出さず、データ・系統図の API も 403。ただし、どこかの拠点で制御室の人は、ほかの拠点も表示だけできる（`viewOnly`。配管系統図トップの現在状況のみ、操作は不可）。承認とメールの宛先も拠点での権限で決める。
- **保存先**：Supabase Auth の `app_metadata.roles`（配列）・`siteRoles`。service role キーでしか書き換えられず、ログインのトークン（JWT）にも入るため利用者が改ざんできない。新しいテーブルは無い。1人に複数付けられる（例：チームリーダー＋制御室）。
- **未設定の利用者**は作業者として扱う。環境変数 `ADMIN_LOGIN_IDS`（ログイン ID のカンマ区切り）の利用者は常に管理者（`/api/me` を開いたときに `app_metadata` にも管理者を書き込む）。この利用者の管理者権限の削除・無効化、自分自身の無効化、最後の管理者の管理者権限の削除はできない。
- **無効化**：Supabase Auth の利用停止（`ban_duration`）。ログイン・トークン更新ができなくなり、API（`requireAuth`）は `banned_until` を見て 401 を返す。利用者の削除はしない（記録に名前が残るため）。
- **判定の場所**：定義は `src/lib/roles.ts` に集約。画面は `AuthGate` がページごとの権限（`PAGE_PERMS`）を見て中身を出さず、メニュー（ホーム・配管系統図トップ・⚙ 管理設定）も開けないものは出さない。API は `requirePerm()`（ユーザー管理・系統図の版）と、`/api/piping` の操作ごとの権限（`STORE_ACTION_PERMS`）で 403 を返す。既存系はブラウザから DB へ直接書くため、サーバー側の制限は `auth_roles_rls.sql`（RLS）で行う。RLS はトークンの `app_metadata` を見るため、権限の変更が DB 側に効くのはトークンの更新後（最長1時間）。列ごとの制限は無い（作業者は QR 発行済みの記録のため `equipment` を更新できるが、ほかの列も書き換えられる）。

### 4.4 NFC タグ識別（`equipment_identifiers`）

SQL は `supabase/equipment_identifiers.sql`。**本番未実行**（ユーザー作業。`auth_roles_rls.sql` の後に SQL Editor で実行）。既存テーブルは変更しません。ブラウザ（`src/lib/identifiers.ts`）から Supabase へ直接アクセスし、RLS で制限します。

| 列 | 内容 |
|---|---|
| `identifier_type` | `QR` / `NFC`。`QR` は将来用で、QR はこのテーブルに行を作らない |
| `identifier_value` | 正規化した UID（16 進大文字 14 桁、7 バイト） |
| `equipment_code` | 機器番号（QR の中身と同じ）。`equipment.code` と配管系統図の `node.label` の両方を指すため、外部キーは持たない |
| `display_number` | 管理番号 |
| `status` | `ACTIVE` / `DISABLED` |
| `note`・`updated_by`・`created_at`・`updated_at` | 備考・更新者・作成日時・更新日時 |

| 制約 | 内容 |
|---|---|
| 一意 | (`identifier_type`, `identifier_value`) |
| 形式 | NFC の UID 形式チェック |
| 1 機器 1 枚 | 有効な NFC は 1 機器につき 1 枚 |
| 管理番号 | 有効なタグの管理番号は重複不可 |
| 削除 | 行は削除しない（`DISABLED` で無効化） |

| RLS 操作 | 許可 |
|---|---|
| 読み取り | ログイン利用者全員 |
| 追加・更新 | 作業者・チームリーダー・G長・管理者 |
| 削除 | 削除ポリシー無し |

初期データは `supabase/equipment_identifiers_seed.sql`（デモ用タグ 10 枚、管理番号 1〜10、未割当）と `supabase/demo_nfc_tags.csv`。SQL は、ローカル Postgres 16 で冪等性・制約・RLS を確認済みです。

## 5. 配管系統図系の設計

### 5.1 データの流れ

```
DB（版：論理データ＋図面データ）
  → /api/piping/diagram（使用中の版を Facility 型へ変換）
  → useGraph()：buildGraph() でグラフ（区間 Section・隣接）を構築
  → 各ドメイン関数（isolation / workTypes / fireTest / ruleBlocks）でチェックリスト（SavedPlan）を算定
  → /api/piping（POST の StoreAction）で piping_store に保存
  → usePipingStore()：1.5 秒ごとのポーリング（polling）で現場・制御室が同じデータを見る
```

### 5.2 主要モジュール（`src/lib/piping/`）

| ファイル | 役割 |
|---|---|
| `types.ts` | ノード種別（弁・逆止弁・タンク・ポンプ・ドレン・消火設備など）・配管・施設の型 |
| `graph.ts` | グラフ構築、区間分割、最短経路、ダブルブロック（`secondBlock`）、経路側の分岐弁 |
| `isolation.ts` | 遮断範囲・液封リスク・抜取量／時間・充填計画の算定（燃料抜取）。抜取時間（`estimateDrain`）は固定の抜取ポンプ、無ければローリー（`LorrySetting`）の能力で1か所から抜く前提 |
| `workTypes.ts` | 作業種別（drain / flush / tankIsolation / fireTest / custom）と当日選択（DayParams）による行生成 |
| `fireTest.ts` | 消火設備機能試験（発泡装置・隣接タンク冷却散水・消火栓） |
| `rules.ts` / `ruleBlocks.ts` | 拠点ごとのチェックリスト作成ルールと、ノーコードの追加ルール（もし〜なら工程ごとに開閉） |
| `checklist.ts` | チェックリストの型（PlanRow / SavedPlan）、Excel 入出力、工程ごとの状態 |
| `store.ts` | 共有ストアの型・StoreAction・`execPlan()`（当日選択の重ね合わせ） |
| `execution.ts` / `live.ts` / `flow.ts` | 点検進捗の表示、トップ・制御室の現在状況図、工程ごとの流れの向き（`routeFlowGroups`：循環・移送・泡／水系統の経路を流れの種類ごとにまとめ、色と凡例名を付ける） |
| `operations.ts` / `outages.ts` | 制御室の運用入力（運用ライン）と当日の運用停止範囲（既定の範囲と、拠点ごとに登録した範囲 `OutageSetting`） |
| `diagramData.ts` / `diagramDb.ts` | Excel ⇔ 系統図データ変換・入力チェック、DB 行 → Facility 変換 |
| `impact.ts` | 系統図の版を切り替えるときの既存チェックリストへの影響チェック。作成時の版と新しい版を機器番号・配管番号で突き合わせ、影響なし／図面の付け替え（配管が節点で分けられただけ）／作り直し（弁・機器の増減や属性の変更、つながりの変更、範囲の容量の5%超の変化）に分ける。④ で版を使用中にする前に一覧を出し、`applyDiagramImpact` で版の記録の更新・配管番号の付け替え・差し戻しを行う |
| `diagramEdit.ts` | 系統図エディタの編集操作（移動・経由点・配管途中への挿入・枝・置く・配管を引く・削除・属性変更・変更点のまとめ）。`DiagramData` → 新しい `DiagramData` の純粋関数 |
| `facility.ts` | プログラム内の仮想施設（DB が無いときのフォールバック（fallback）） |
| `usePiping.ts` | 拠点選択（localStorage）・グラフ・ストアのフック |

### 5.3 API（`src/app/api/piping/`）

すべて `requireAuth()` で Bearer トークンを検証し、**その利用者として** Supabase に接続します（RLS 上 authenticated 扱い）。操作者名は記録（`by` / `confirmedBy` / `updatedBy` / `approvedBy`）に残します。権限は 4.3 のとおり操作ごとに確かめます（足りなければ 403）。

| エンドポイント | 内容 |
|---|---|
| `GET/POST /api/piping?facility=` | 拠点のストア取得・StoreAction の適用。本番（Vercel）は Supabase、ローカル `next dev` は `.local-data/` のファイル（`PIPING_STORE=supabase|file` で強制可） |
| `GET /api/piping/diagram` | 使用中の版を返す。読む順：v2 構造 → 第1版構造 → プログラム内の仮想施設（`PIPING_DIAGRAM=builtin` で DB を読まない） |
| `GET/POST /api/piping/diagram/versions` | 版の一覧・中身・取込（下書き作成）・使用中へ切替・下書き削除（管理者のみ） |
| `GET /api/piping/facilities` | 拠点一覧と使用中の版番号 |
| `GET /api/me` | ログイン中の利用者の名前・権限（画面の出し分けに使う） |
| `GET/POST /api/admin/users` | ユーザー管理（管理者のみ、service role キー）。一覧・作成（ログイン ID＋初期パスワード、メール確認なし）・名前と権限の変更・パスワード再設定・無効化／有効に戻す |

## 6. 設計思想（守るべき原則）

1. **既存系を壊さない**：配管系統図系は既存テーブルに書き込まない。新機能は新テーブル・新 JSON 項目で追加し、SQL は「既存テーブルに一切変更を加えない」「何度実行しても安全」を守る。
2. **論理データと図面データの分離**：計算（遮断・経路・容量）は論理データだけで行い、座標は図面シートごとに持つ。座標が無くても計算できる。
3. **版管理とスナップショット**：系統図は版で管理し、チェックリストは作成時の版 ID・適用ルール（`appliedRules`）・ユーザー定義作業（`customType`）をスナップショットとして保持する。後からルールや系統図を変えても既存のチェックリストは変わらない。
4. **ルールはデータ、ロジックはコード**：作業ごとの決まりは拠点単位で `piping_store.rules` に保存し、未登録の項目は既定値（`DEFAULT_*`）で補う。ユーザーがノーコードで作業種別・追加ルールを組み立てられる。
5. **当日選択の重ね合わせ**：充填元タンク・移送ポンプ・末端部／縁切りのタンク・ポンプは点検当日に選び、`execPlan()` で元のチェックリストに重ねる（元データは書き換えない）。
6. **ローカル開発は本番データに触れない**：`next dev` では piping_store をファイルに保存する。ただし既存系と系統図 DB の読込は `.env.local` の本番 Supabase を使う点に注意。
7. **段階的フォールバック**：DB・テーブルが無い場合もプログラム内の仮想施設で動く。保存テーブルが無いときは実行すべき SQL を案内するエラーを返す。
8. **楽観的排他**：複数端末・複数サーバーからの同時更新は `version` 一致時のみ書き込み、最大5回やり直す（失敗時 409）。
9. **画面文言・コメントは日本語、コミットメッセージは英語**（`Add:` / `Fix:` / `Change:` / `Remove:` などの接頭辞）。

## 7. 運用・開発手順

- 開発サーバー：`.claude/launch.json` の `dev`（http://localhost:3000）または `dev-https`（実機カメラ試験用、`certificates/` の証明書）。LAN 実機からは `allowedDevOrigins` の 192.168.0.21。
- ブランチ運用：`local/<機能名>` ブランチで作業 → main へ fast-forward → push（Vercel 自動デプロイ）。push はユーザーの承認後に行う。
- SQL の変更：`supabase/` に新しいファイルを追加し、ユーザーに SQL Editor での実行を依頼する。
- 利用者の追加：管理者がユーザー管理（`/admin/users`）で作成し、権限を付ける。ログイン ID はメールの @ より前（ID だけを入れると `ID@valve-check.local`）。
- 環境変数：`SUPABASE_SERVICE_ROLE_KEY`（ユーザー管理に必須。サーバー側だけで使う）、`ADMIN_LOGIN_IDS`（最初の管理者）、`SMTP_USER`・`SMTP_PASS`（Gmail で送るとき）または `RESEND_API_KEY`、`MAIL_FROM`（承認フローのメール。どちらも無ければ送らない）。ローカルは `.env.local`、本番は Vercel の環境変数に設定する（`.env.local.example` 参照）。
- 同じフォルダーで `next dev` は1つしか動かせない（Next.js 16 のロック）。別のチャットが動かしているときは、その 3000 番のサーバーを使う。
