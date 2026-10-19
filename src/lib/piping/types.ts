// 配管系統図（仮想空港給油施設）のデータモデル。
// 図面は「ノード（機器・バルブ・分岐点）」と「配管（ノード間を結ぶ線）」のグラフとして持つ。
// このモジュール群は既存システムのテーブル（機器マスター・チェックリスト等）には書き込まない。
// 保存は /api/piping 経由（本番：Supabase の piping_store、ローカル開発：.local-data のファイル）。

export type ValveState = "open" | "close";

export type NodeKind =
  | "junction" // 配管の分岐・曲がり点（記号なし）
  | "valve" // 仕切弁（遮断に使えるバルブ）
  | "check" // 逆止弁（遮断には使わない）
  | "tank" // 貯蔵タンク
  | "pump" // 払出ポンプ
  | "transferPump" // 移送ポンプ
  | "strainer"
  | "filter"
  | "psv" // 安全弁
  | "drain" // ドレン口（抜取口。ドレン弁つき）
  | "gauge" // 圧力計取付口（元弁つき）
  | "source" // 受入口（施設外）
  | "sink"; // ハイドラント（施設外）

export type PNode = {
  id: string;
  kind: NodeKind;
  /** 図面上・チェックリスト上の表示コード（バルブ番号など） */
  label: string;
  /** 日本語名称 */
  name: string;
  x: number;
  y: number;
  /** 区画名（受入系統A、第1ヤード など） */
  area: string;
  /** バルブ・ドレン弁・圧力計元弁の待機時（通常）状態 */
  normal?: ValveState;
  /** 機器内容量（L）。ストレーナー・フィルター・ポンプのケーシングなど */
  volumeL?: number;
  /** ドレン口の口径（A） */
  drainSizeA?: number;
  /** 圧力計を取り付けられるか（ドレン口・圧力計取付口） */
  gaugeMountable?: boolean;
  /** 作業用の弁（充填弁など）。運用ラインの経路探索では通らない */
  service?: boolean;
  /** 充填ライン上の弁（充填経路の探索で通過できる） */
  fillLine?: boolean;
  /** 充填の供給元（移送ポンプ吐出側の分岐点） */
  fillSource?: boolean;
  /** 固定の抜取ポンプが設置されている場合の能力（L/min） */
  drainPumpLpm?: number;
  /** ポンプ・逆止弁の上流側ノードID（流れの向き） */
  dirFrom?: string;
  /** 回収タンク（安全弁の逃がし先。貯蔵タンクではない） */
  recovery?: boolean;
  /** 図面でラベルを省略する（タンク弁の逃し弁など、数が多いもの） */
  compact?: boolean;
  /** タンク容量（kL） */
  capacityKL?: number;
  /** 安全弁の設定圧力（MPa） */
  setPressureMPa?: number;
};

export type Pipe = {
  id: string;
  a: string;
  b: string;
  /** 呼び径（A） */
  sizeA: number;
  /** 経由点（直角に曲げて描くための中間座標） */
  via?: [number, number][];
  /** 実長（m）。省略時は図面上の長さ×縮尺で概算 */
  lengthM?: number;
};

export type AreaBox = { x: number; y: number; w: number; h: number; label: string };

export type Facility = {
  name: string;
  width: number;
  height: number;
  /** 図面1px あたりの実長（m） */
  metersPerPx: number;
  nodes: PNode[];
  pipes: Pipe[];
  areas: AreaBox[];
};

/** 弁として操作対象になるノード（チェックリストに載る） */
export function isOperable(kind: NodeKind) {
  return kind === "valve" || kind === "drain" || kind === "gauge";
}
