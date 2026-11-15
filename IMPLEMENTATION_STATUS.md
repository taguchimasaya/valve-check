# IMPLEMENTATION_STATUS — 実装済み・未実装機能

2026-11-15 時点（main = `9f7a199`、作業ブランチ `local/fire-test` も同じコミット）の実装状況です。
ソースコード・Git・本番 Supabase（匿名キーでの読み取り確認）を調査した結果に基づきます。
機能を追加・変更したら、この資料も更新してください。構成は [ARCHITECTURE.md](ARCHITECTURE.md)、経緯は [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md) を参照してください。

凡例：✅ 実装済み・本番反映済み　⚠️ 実装済みだが課題あり　⏳ ユーザー作業待ち　❌ 未実装

---

## 1. 現在の状態サマリー

| 項目 | 状態 |
|---|---|
| Git | main = origin/main = `9f7a199`。`local/*` ブランチ 23 本はすべて main にマージ済み。未コミットは `CLAUDE.md` の変更と資料類（pptx・docx・xlsx・`SYSTEM_*.md`・`diagrams/`・`screenshots/`・`scripts/` など） |
| 型チェック（type check） | `npx tsc --noEmit` 成功（エラー 0） |
| 本番デプロイ | Vercel（main 自動デプロイ）。最終反映は `9f7a199` |
| 本番 DB の拠点 | `virtual-airport`（仮想空港 給油施設、第1版が使用中）、`virtual-site-2`（臨海石油基地、第6版が使用中、第1〜5版は保管） |
| 本番 DB の件数 | equipment 184、checklist_templates 3、inspection_sessions 69、inspection_results 449、piping_nodes 2,518、piping_pipes 2,650、piping_sheets 7 |
| piping_store | `main`（version 223）、`virtual-site-2`（version 3） |

## 2. 共通基盤

| 機能 | 状態 | 備考 |
|---|---|---|
| ID・パスワードログイン（Supabase Auth） | ✅ | `/login`。ID＝メールの @ より前（DB 関数 `login_email`）。見つからなければ `ID@valve-check.local` |
| 全ページのログイン必須化 | ✅ | `AuthGate`。ログイン後は元の画面（QR で開いた画面を含む）へ戻る |
| API のトークン検証 | ✅ | `/api/piping/*` は Bearer トークン必須（`requireAuth`） |
| ログアウト（この端末のみ） | ✅ | `signOut({ scope: "local" })`。共有 ID でも他端末はログインしたまま |
| 利用者名の表示・操作者の記録（配管系統図系） | ✅ | `UserBadge`、記録・確認・保存した人を保存 |
| DB をログイン利用者に限定（RLS） | ⏳ | `supabase/auth_rls.sql` が**本番未実行**。現状は匿名キーで全テーブル（piping_store の点検記録を含む）が読み書き可能 |
| 利用者管理画面 | ❌ | Supabase 管理画面で作成する運用（Auto Confirm） |
| 権限（ロール）による画面・操作の制限 | ❌ | ログイン済みなら全機能を使える |
| 自動テスト | ❌ | テストフレームワーク未導入 |

## 3. A. 既存系（QR チェックリスト）

| 機能 | 状態 | 備考 |
|---|---|---|
| 機器マスター管理・Excel/CSV 取込・QR 発行／印刷 | ✅ | `/equipment`、`/equipment/print` |
| 手順チェックリスト Excel 取込・プレビュー・書出し | ✅ | `/checklists` |
| 現場チェック（QR 読取 → 開閉選択ダイアログ → 記録） | ✅ | `/inspect`、`/inspect/[code]`。対象外の弁は NG ビープ |
| 工程の開始・完了通知と読み上げ | ✅ | `step_notifications` / `step_start_notifications` を Realtime で制御室へ |
| 制御室ダッシュボード（マルチモニター仮想デスクトップ、複数セッション同時監視） | ✅ | `/control-room` |
| 結果の Realtime 同期 | ✅ | 1 秒ポーリングから Realtime に変更済み |
| 音声・表示設定 | ✅ | `/settings` |
| 点検開始（チェックリスト選択）通知 | ⚠️ | `inspection_start_notifications` テーブルが**本番に存在しない**（PGRST205）。`/inspect` の insert は失敗し、制御室の購読は発火しない |
| 操作者の記録（`checked_by` / `created_by`） | ⚠️ | ログイン導入後も既存系では未設定。`confirmed_by` は固定文字列「制御室」 |
| 未使用コード | ⚠️ | `isLastStepComplete()`（`src/app/inspect/page.tsx`）、`/inspect/[code]` の `ensureActiveSession` import |
| `/inspect` と `/control-room` の型・グリッド構築の共通化 | ❌ | 両ページで重複実装 |

## 4. B. 配管系統図系（/piping）

### 4.1 チェックリスト作成（① `/piping/planner`）

| 作業種別 | 状態 | 内容 |
|---|---|---|
| 燃料抜取（drain） | ✅ | 図面で対象を選ぶ → 遮断範囲・操作弁・液封リスク・抜取量／時間・充填。逆止弁の向き、回収設備（受入A）、分岐弁の閉を考慮。工程：作業前→ラインナップ→抜取→充填→復旧 |
| 燃料末端部作業（flush） | ✅ | 末端部配管を選び、当日のタンク・ポンプで循環経路を作る。工程：作業前→ラインナップ→循環→復旧 |
| タンク縁切り（tankIsolation） | ✅ | 払出系統・移送系統で別タンクへ移送して縁切り |
| 消火設備機能試験（fireTest） | ✅ | 試験タンクの発泡装置、隣接タンク（上下左右）の冷却散水、近くの消火栓（泡・水）。工程：ラインナップ→シリンダー弁開（制御室）→ポンプ起動→泡系統試験→水系統試験→試験終了→復旧 |
| ユーザー定義の作業（custom） | ✅ | ⑤ で工程とブロックを組み立てた作業。作成時にスナップショット |
| 仕切り方（1ブロック／ダブルブロック＋ブリード） | ✅ | 拠点共通ルール。図面・境界数にも第2ブロック弁を表示 |
| チェックリストのプレビュー・Excel 書出し／取込 | ✅ | 既存形式の Excel も取込可 |
| 印刷・PDF（A4 横、工程ごとの図面） | ✅ | `/piping/print` |

### 4.2 点検・監視

| 機能 | 状態 | 備考 |
|---|---|---|
| 現場点検（図面ビュー、QR 読取・タップで記録、対象弁へのズーム、色分け） | ✅ | `/piping/field` |
| 当日の選択（充填元タンク・移送ポンプ、末端部／縁切りのタンク・ポンプ） | ✅ | `FillSupplyPicker` / `DayParamsPicker`、`execPlan()` で重ねる |
| 制御室（運用入力→運用ライン表示、点検ラインの点滅、操作済み弁の点灯、確認） | ✅ | `/piping/control` |
| 当日の運用停止範囲 | ✅ | 制御室で入力し、トップ・制御室の図面に表示 |
| トップの現在状況図 | ✅ | `/piping` |
| 系統図の弁 QR 印刷 | ✅ | `/piping/qr`（既存機器 QR と同じ形式） |
| 現場⇔制御室の同期 | ⚠️ | 1.5 秒ポーリング（Realtime ではない）。piping_store は拠点ごと1行 JSON のため、データ増加で読み書き量が増える |

### 4.3 系統図データ・ルール

| 機能 | 状態 | 備考 |
|---|---|---|
| 系統図データの DB 化（論理データ／図面データ分離、版管理） | ✅ | `piping_diagram_v2.sql` 構造 |
| 複数拠点（拠点切替は端末ごとに記憶） | ✅ | `FacilitySwitcher` |
| 消火設備（消火栓・放水銃・散水ヘッド・泡混合器・発泡装置）と流体・系統 | ✅ | 水＝青、泡＝紫 |
| ④ 系統図データ管理（Excel 書出し・取込 → 下書き → 使用中へ切替、入力チェック） | ✅ | `/piping/data` |
| ⑤ チェックリスト作成のルール（全作業種別、ノーコードのルールブロック、ユーザー定義の作業） | ✅ | `/piping/rules`、拠点ごとに `piping_store.rules` |
| 古いチェックリストと新しい版の整合 | ⚠️ | チェックリストは配管 ID（P###）を保存するため、系統図の変更後は範囲・充填ラインの表示がずれる（作り直しが必要）。`diagramVersionId` は保存するが、版の違いによる警告・移行は未実装 |
| 座標なしの Excel 取込（未配置から始めて配置する） | ❌ | 構想のみ（下絵エディタは 2026-11-01 に削除済み） |
| 図面上での系統図編集（GUI エディタ） | ❌ | 編集は Excel 経由のみ |
| 実施設データの投入 | ❌ | 現在は仮想施設2拠点のみ |

## 5. 優先度の高い課題（次に着手する候補）

1. **`auth_rls.sql` の本番実行**（ユーザー作業）：匿名キーで点検記録まで読める状態の解消。実行後、GitHub Actions の keep-alive（匿名キーで `equipment` を読む）が 0 件応答でも成功するかの確認が必要です。
2. **`inspection_start_notifications` テーブルの作成 SQL 追加**：既存系の点検開始通知を機能させる。
3. **既存系の操作者記録**：ログイン利用者名を `checked_by` / `confirmed_by` / `created_by` に設定する。
4. **系統図の版とチェックリストの整合チェック**：使用中の版とチェックリスト作成時の版が違う場合の警告。
5. **自動テストの導入**：`isolation.ts`・`workTypes.ts`・`fireTest.ts` などの算定ロジックは純粋関数のため、単体テスト（unit test）を入れやすい。
