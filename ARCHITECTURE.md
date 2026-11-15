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
| **A. 既存系（QRチェックリスト）** | `/equipment` `/checklists` `/inspect` `/inspect/[code]` `/control-room` `/settings` | 機器マスター（equipment）と Excel 取込のチェックリストを使い、現場 iPad の QR 読取で工程ごとに弁操作を記録し、制御室 PC がリアルタイム（Realtime）で監視する |
| **B. 配管系統図系（/piping）** | `/piping/planner` `/piping/field` `/piping/control`（運用停止範囲の設定を含む） `/piping/qr` `/piping/print`、管理設定（トップ右上）：`/piping/data`（`/piping/editor` を含む） `/piping/rules` | 配管系統図（グラフ構造）から遮断範囲・操作弁を自動算定してチェックリストを作り、図面上で現場点検・制御室監視を行う |

両系統はホーム画面（`/`）から入り、**ログイン（Supabase Auth）を共通**で使います。データは互いに独立しており、配管系統図系は既存系のテーブルに書き込みません（QR の形式 `/inspect/{code}` のみ共通）。

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
| Excel | `xlsx` 0.18.5（取込・書出し） |
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
    equipment/, equipment/print/  機器マスター・QR 印刷（既存系）
    checklists/                   チェックリスト取込（既存系）
    inspect/, inspect/[code]/     現場チェック（既存系、QR から直接開く画面を含む）
    control-room/                 制御室ダッシュボード（既存系、マルチモニター仮想デスクトップ）
    settings/                     音声・表示設定
    piping/                       配管系統図系（planner/field/control/data/rules/qr/print）
    api/piping/                   配管系統図系の API（route.ts、diagram/、diagram/versions/、facilities/）
  components/
    AuthGate.tsx, UserBadge.tsx   ログイン必須化・利用者表示
    piping/                       系統図描画（PipingDiagram）・プレビュー・各種ピッカー・ルール編集
  lib/
    supabase.ts                   ブラウザ用 Supabase クライアント
    auth.ts                       ログイン・ログアウト・authFetch（Bearer トークン付き fetch）
    serverAuth.ts                 API 側のトークン検証（requireAuth）
    inspectionSession.ts ほか     既存系のセッション・音声・弁操作判定・Excel 解析
    piping/                       配管系統図系のドメインロジック（下記 5 章）
supabase/                         SQL（SQL Editor で手動実行する。マイグレーションツールは未使用）
tools/piping-diagram/             サンプル系統図データ生成スクリプト（seed・第2拠点）
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
- `auth_rls.sql`：`demo: allow all` ポリシーを `logged in: all`（authenticated のみ）に置き換える。**2026-11-15 時点で本番未実行**（匿名キー（anon key）で全テーブルが読めることを確認済み）。

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
| `isolation.ts` | 遮断範囲・液封リスク・抜取量／時間・充填計画の算定（燃料抜取） |
| `workTypes.ts` | 作業種別（drain / flush / tankIsolation / fireTest / custom）と当日選択（DayParams）による行生成 |
| `fireTest.ts` | 消火設備機能試験（発泡装置・隣接タンク冷却散水・消火栓） |
| `rules.ts` / `ruleBlocks.ts` | 拠点ごとのチェックリスト作成ルールと、ノーコードの追加ルール（もし〜なら工程ごとに開閉） |
| `checklist.ts` | チェックリストの型（PlanRow / SavedPlan）、Excel 入出力、工程ごとの状態 |
| `store.ts` | 共有ストアの型・StoreAction・`execPlan()`（当日選択の重ね合わせ） |
| `execution.ts` / `live.ts` / `flow.ts` | 点検進捗の表示、トップ・制御室の現在状況図、工程ごとの流れの向き |
| `operations.ts` / `outages.ts` | 制御室の運用入力（運用ライン）と当日の運用停止範囲（既定の範囲と、拠点ごとに登録した範囲 `OutageSetting`） |
| `diagramData.ts` / `diagramDb.ts` | Excel ⇔ 系統図データ変換・入力チェック、DB 行 → Facility 変換 |
| `diagramEdit.ts` | 系統図エディタの編集操作（移動・経由点・配管途中への挿入・枝・置く・配管を引く・削除・属性変更・変更点のまとめ）。`DiagramData` → 新しい `DiagramData` の純粋関数 |
| `facility.ts` | プログラム内の仮想施設（DB が無いときのフォールバック（fallback）） |
| `usePiping.ts` | 拠点選択（localStorage）・グラフ・ストアのフック |

### 5.3 API（`src/app/api/piping/`）

すべて `requireAuth()` で Bearer トークンを検証し、**その利用者として** Supabase に接続します（RLS 上 authenticated 扱い）。操作者名は記録（`by` / `confirmedBy` / `updatedBy`）に残します。

| エンドポイント | 内容 |
|---|---|
| `GET/POST /api/piping?facility=` | 拠点のストア取得・StoreAction の適用。本番（Vercel）は Supabase、ローカル `next dev` は `.local-data/` のファイル（`PIPING_STORE=supabase|file` で強制可） |
| `GET /api/piping/diagram` | 使用中の版を返す。読む順：v2 構造 → 第1版構造 → プログラム内の仮想施設（`PIPING_DIAGRAM=builtin` で DB を読まない） |
| `GET/POST /api/piping/diagram/versions` | 版の一覧・中身・取込（下書き作成）・使用中へ切替・下書き削除 |
| `GET /api/piping/facilities` | 拠点一覧と使用中の版番号 |

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
- 利用者の追加：Supabase 管理画面で作成（Auto Confirm）。ログイン ID はメールの @ より前。
