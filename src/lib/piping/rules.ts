// チェックリスト作成のルール（拠点ごとにユーザーが編集・登録する）。
// 保存先は拠点ごとの共有ストア（piping_store の rules）。未登録の項目は既定値を使う。

/** 消火設備機能試験のルール */
export type FireTestRules = {
  /** 試験の順番：泡 → 水 か、水 → 泡 か */
  order: "foamFirst" | "waterFirst";
  /** 使う消火栓の口数 */
  waterHydrants: number;
  foamHydrants: number;
  /** 消火栓は同じヤード（区画）のものを優先する */
  hydrantSameAreaFirst: boolean;
  /** 試験タンクの冷却散水からも散水する */
  testTankSprinkle: boolean;
  /** 隣接タンクとみなす並び */
  adjacency: { horizontal: boolean; vertical: boolean; diagonal: boolean };
  /** 隣接タンクで使う冷却散水：試験タンクに向いた側だけ／すべて／使わない */
  adjacentLines: "facing" | "all" | "none";
  /** 冷却散水のシリンダー弁を開ける工程：シリンダー弁開（制御室）の工程／水系統試験の工程 */
  sprinklerOpenAt: "cylinderStep" | "waterStep";
  /** 同じヤードのほかのタンクの発泡装置の手動弁を閉める（シリンダー弁は閉を確認） */
  closeOtherFoam: boolean;
  /** 試験範囲外へ分岐する弁で、普段開のものを閉めて仕切る */
  isolateOutside: boolean;
  /** 消火ポンプ室（ポンプのある区画）の弁は仕切りの対象にしない */
  keepPumpArea: boolean;
  /** シリンダー弁の見分け方：名称に含む語、または番号の先頭（カンマ区切り） */
  cylinderKeywords: string;
  /** 主消火ポンプの見分け方：名称に含む語 */
  mainPumpKeyword: string;
};

/** 燃料抜取のルール */
export type DrainRules = {
  /** 対象区間にドレン口が無ければ、ドレン口のある区間まで遮断範囲を広げる（作成画面の初期値） */
  expandToDrain: boolean;
  /** 範囲内の弁（普段閉のもの）をラインナップで開ける */
  openInternal: boolean;
  /** 充填ラインが無いとき、遮断弁を微開して充填する（しない場合は充填工程で操作しない） */
  crackFillWithoutLine: boolean;
  /** 可搬ポンプの能力（L/min・作成画面の初期値） */
  portableLpm: number;
  /** 充填の流量（L/min・作成画面の初期値） */
  fillLpm: number;
  /** 自然流下の抜取能力（口径別 L/min） */
  gravityLpm: { "25": number; "40": number; "50": number; "80": number };
};

/** 燃料末端部作業（循環）のルール */
export type FlushRules = {
  /** 循環量の目安：末端部の配管容量の何倍を流すか */
  turnover: number;
  /** 時間の試算に使うポンプ能力（L/min） */
  pumpLpm: number;
  transferPumpLpm: number;
  /** 経路から分岐する先の弁を閉める */
  closeSide: boolean;
};

/** タンク縁切り作業のルール */
export type IsolationRules = {
  /** 経路から分岐する先の弁を閉める */
  closeSide: boolean;
  /** 縁切りの工程に仕切板挿入の注記を入れる */
  blindNote: boolean;
};

/** 拠点共通：仕切り方（仕切る弁の数） */
export type BlockMethod = {
  /** 1：1ブロック（弁1つで仕切る）、2：2ブロック（ダブルブロック。外側の区間を囲む弁も閉める） */
  blocks: 1 | 2;
  /** 2ブロックのとき、2つの弁の間の区間のドレン口を開けて抜く・確認する（ダブルブロック＆ブリード） */
  bleed: boolean;
};
export const DEFAULT_BLOCK_METHOD: BlockMethod = { blocks: 1, bleed: false };
export function blockMethodOf(rules: ChecklistRules | null | undefined): BlockMethod {
  return { ...DEFAULT_BLOCK_METHOD, ...(rules?.blockMethod ?? {}) };
}

export type BuiltinWorkType = "drain" | "flush" | "tankIsolation" | "fireTest";

export type ChecklistRules = {
  /** 拠点共通の仕切り方 */
  blockMethod?: Partial<BlockMethod>;
  fireTest?: Partial<FireTestRules>;
  drain?: Partial<DrainRules>;
  flush?: Partial<FlushRules>;
  tankIsolation?: Partial<IsolationRules>;
  /** 作業種別ごとの追加ルール（ブロック） */
  blocks?: Partial<Record<BuiltinWorkType, RuleBlock[]>>;
  /** ユーザーが作った作業種別 */
  customTypes?: CustomWorkType[];
  updatedAt?: string;
};

// ───────────── ルールブロック（ノーコードで組み立てる「もし〜なら、〜する」） ─────────────

/** 対象との関係 */
export type BlockRelation = "any" | "targetBranch" | "targetOutletBranch" | "onRoute" | "routeBranch";

export const RELATION_LABEL: Record<BlockRelation, string> = {
  any: "指定なし（系統図全体）",
  targetBranch: "対象（タンク・機器）につながる最初の弁",
  targetOutletBranch: "対象タンクに付いた設備（冷却散水・発泡装置）の枝の弁",
  onRoute: "作業の範囲・経路の上",
  routeBranch: "作業の範囲・経路から分岐する先の最初の弁",
};

/** 機器の条件（すべて満たすもの） */
export type BlockSelector = {
  relation: BlockRelation;
  /** 機器の種類（空なら弁） */
  kinds: string[];
  /** 流体（空なら指定なし） */
  fluids: string[];
  /** 区画："any"・"same"（対象と同じ）・"other"（対象と別）・"area:区画名" */
  area: string;
  /** 待機時の状態 */
  normal: "any" | "open" | "close";
  /** 名称に含む語（空なら指定なし） */
  nameIncludes: string;
  /** 番号の先頭（空なら指定なし） */
  codePrefix: string;
  /** 対象に近い順に何個（0 ならすべて） */
  nearest: number;
  /** 「最初の弁」の関係で、何ブロック目まで選ぶか（1：最初の弁だけ、2：その外側の弁も＝ダブルブロック） */
  depth: 1 | 2;
};

export type RuleBlock = {
  id: string;
  name: string;
  enabled: boolean;
  when: BlockSelector;
  /** 工程名 → その工程での状態（弁：開／閉、ポンプ：起動／停止） */
  ops: Record<string, "open" | "close">;
  /** 最後の工程で待機状態に戻す */
  restore: boolean;
  /** チェックリストに載せる注記 */
  note: string;
};

export type CustomStep = { name: string; manual: boolean; note: string };

/** ユーザーが作る作業種別 */
export type CustomWorkType = {
  id: string;
  name: string;
  desc: string;
  /** 図面で選ぶ対象 */
  target: "tank" | "equipment" | "none";
  /** 工程（「作業前」は自動で先頭に入る） */
  steps: CustomStep[];
  /** 作業の経路：条件に合う機器（最も近いもの）から対象まで。経路上・分岐先の条件と、流れの表示に使う */
  route: { enabled: boolean; from: BlockSelector; showAt: string[] };
  blocks: RuleBlock[];
};

export const EMPTY_SELECTOR: BlockSelector = {
  relation: "any",
  kinds: ["valve"],
  fluids: [],
  area: "any",
  normal: "any",
  nameIncludes: "",
  codePrefix: "",
  nearest: 0,
  depth: 1,
};

export function newRuleId() {
  return Math.random().toString(36).slice(2, 10);
}

export function newBlock(name = "新しいルール"): RuleBlock {
  return { id: newRuleId(), name, enabled: true, when: structuredClone(EMPTY_SELECTOR), ops: {}, restore: true, note: "" };
}

export function newCustomType(): CustomWorkType {
  return {
    id: newRuleId(),
    name: "新しい作業",
    desc: "",
    target: "tank",
    steps: [
      { name: "ラインナップ", manual: false, note: "" },
      { name: "作業", manual: true, note: "" },
      { name: "復旧", manual: false, note: "" },
    ],
    route: { enabled: false, from: { ...structuredClone(EMPTY_SELECTOR), kinds: ["pump"] }, showAt: [] },
    blocks: [newBlock("対象につながる弁を閉める")].map((b) => ({
      ...b,
      when: { ...b.when, relation: "targetBranch" as const },
      ops: { ラインナップ: "close" as const },
    })),
  };
}

export const DEFAULT_DRAIN_RULES: DrainRules = {
  expandToDrain: true,
  openInternal: true,
  crackFillWithoutLine: true,
  portableLpm: 300,
  fillLpm: 200,
  gravityLpm: { "25": 40, "40": 90, "50": 150, "80": 350 },
};
export const DEFAULT_FLUSH_RULES: FlushRules = { turnover: 3, pumpLpm: 2000, transferPumpLpm: 1000, closeSide: true };
export const DEFAULT_ISOLATION_RULES: IsolationRules = { closeSide: true, blindNote: true };

export function drainRulesOf(rules: ChecklistRules | null | undefined): DrainRules {
  const r = rules?.drain ?? {};
  return { ...DEFAULT_DRAIN_RULES, ...r, gravityLpm: { ...DEFAULT_DRAIN_RULES.gravityLpm, ...(r.gravityLpm ?? {}) } };
}
export function flushRulesOf(rules: ChecklistRules | null | undefined): FlushRules {
  return { ...DEFAULT_FLUSH_RULES, ...(rules?.flush ?? {}) };
}
export function isolationRulesOf(rules: ChecklistRules | null | undefined): IsolationRules {
  return { ...DEFAULT_ISOLATION_RULES, ...(rules?.tankIsolation ?? {}) };
}
export function blocksOf(rules: ChecklistRules | null | undefined, type: BuiltinWorkType): RuleBlock[] {
  return rules?.blocks?.[type] ?? [];
}

const num = (v: number, name: string, min: number, max: number, errs: string[]) => {
  if (!Number.isFinite(v) || v < min || v > max) errs.push(`${name}は ${min}〜${max} で入力してください`);
};

export function validateDrainRules(r: DrainRules) {
  const errs: string[] = [];
  num(r.portableLpm, "可搬ポンプの能力", 1, 100000, errs);
  num(r.fillLpm, "充填の流量", 1, 100000, errs);
  Object.entries(r.gravityLpm).forEach(([k, v]) => num(v, `自然流下 ${k}A の能力`, 1, 100000, errs));
  return errs;
}
export function validateFlushRules(r: FlushRules) {
  const errs: string[] = [];
  num(r.turnover, "循環量の倍数", 0.1, 100, errs);
  num(r.pumpLpm, "払出ポンプの能力", 1, 100000, errs);
  num(r.transferPumpLpm, "移送ポンプの能力", 1, 100000, errs);
  return errs;
}
export function validateBlocks(blocks: RuleBlock[], steps: string[]) {
  const errs: string[] = [];
  blocks.forEach((b) => {
    if (!b.name.trim()) errs.push("名前の無いルールがあります");
    const unknown = Object.keys(b.ops).filter((s) => !steps.includes(s));
    if (unknown.length) errs.push(`ルール「${b.name}」に無い工程（${unknown.join("・")}）が指定されています`);
    if (!Number.isInteger(b.when.nearest) || b.when.nearest < 0) errs.push(`ルール「${b.name}」の個数は0以上の整数で入力してください`);
  });
  return errs;
}
export function validateCustomType(t: CustomWorkType) {
  const errs: string[] = [];
  if (!t.name.trim()) errs.push("作業の名前を入力してください");
  const names = t.steps.map((s) => s.name.trim());
  if (!names.length) errs.push("工程を1つ以上作ってください");
  if (names.some((n) => !n)) errs.push("名前の無い工程があります");
  if (new Set(names).size !== names.length) errs.push("同じ名前の工程があります");
  if (names.includes("作業前")) errs.push("「作業前」は自動で先頭に入るため、工程名に使えません");
  errs.push(...validateBlocks(t.blocks, ["作業前", ...names]));
  return errs;
}
export const customStepsOf = (t: Pick<CustomWorkType, "steps">) => ["作業前", ...t.steps.map((s) => s.name)];

export const DEFAULT_FIRE_TEST_RULES: FireTestRules = {
  order: "foamFirst",
  waterHydrants: 4,
  foamHydrants: 3,
  hydrantSameAreaFirst: true,
  testTankSprinkle: false,
  adjacency: { horizontal: true, vertical: true, diagonal: false },
  adjacentLines: "facing",
  sprinklerOpenAt: "cylinderStep",
  closeOtherFoam: true,
  isolateOutside: true,
  keepPumpArea: true,
  cylinderKeywords: "シリンダー, CY",
  mainPumpKeyword: "主",
};

/** 登録されたルールに既定値を補う */
export function fireTestRulesOf(rules: ChecklistRules | null | undefined): FireTestRules {
  const r = rules?.fireTest ?? {};
  return {
    ...DEFAULT_FIRE_TEST_RULES,
    ...r,
    adjacency: { ...DEFAULT_FIRE_TEST_RULES.adjacency, ...(r.adjacency ?? {}) },
  };
}

/** 消火設備機能試験の工程 */
export function fireTestSteps(r: Pick<FireTestRules, "order">) {
  const tests = r.order === "foamFirst" ? ["泡系統試験", "水系統試験"] : ["水系統試験", "泡系統試験"];
  return ["作業前", "ラインナップ", "シリンダー弁開（制御室）", "ポンプ起動", ...tests, "試験終了", "復旧"];
}

/** 入力値の確認（問題があれば内容を返す） */
export function validateFireTestRules(r: FireTestRules): string[] {
  const errs: string[] = [];
  const count = (v: number, name: string) => {
    if (!Number.isInteger(v) || v < 0 || v > 30) errs.push(`${name}は 0〜30 の整数で入力してください`);
  };
  count(r.waterHydrants, "消火栓（水）の口数");
  count(r.foamHydrants, "泡消火栓の口数");
  if (!r.cylinderKeywords.split(",").some((k) => k.trim())) errs.push("シリンダー弁の見分け方を1つ以上入力してください");
  return errs;
}
