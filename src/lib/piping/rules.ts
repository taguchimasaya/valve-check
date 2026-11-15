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
  /** 充填の流量（L/min・作成画面の初期値） */
  fillLpm: number;
  /** ローリーの抜取能力（L/min・作成画面の初期値）。抜取ポンプの無いドレン口から抜くときに使う */
  lorryLpm: number;
  /** ローリー1台の容量（kL） */
  lorryCapacityKL: number;
  /** 用意できるローリーの台数（必要な台数がこれを超えると注意を出す） */
  lorryCount: number;
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
export type BlockRelation =
  | "any"
  | "targetBranch"
  | "targetOutletBranch"
  | "onRoute"
  | "routeBranch"
  // 計算の部品「遮断範囲（燃料抜取）」の結果
  | "isoBoundary"
  | "isoInternal"
  | "isoDrain"
  | "isoDrainPump"
  | "isoFillLine"
  | "isoFillCrack"
  | "isoGauge"
  | "isoBleed"
  // 計算の部品「循環経路（燃料末端部作業）」の結果
  | "flushRoute"
  | "flushSide"
  | "flushPump"
  | "flushBleed"
  // 計算の部品「消火試験の範囲」の結果
  | "fireWater"
  | "fireFoamRoute"
  | "fireSprCylinder"
  | "fireFoamCylinder"
  | "fireHydWater"
  | "fireHydFoam"
  | "fireIdleOwn"
  | "fireOtherFoamCyl"
  | "fireOtherFoamManual"
  | "fireOutside"
  | "fireBleed"
  | "firePump"
  | "fireFoamPump"
  // 計算の部品「移送経路（タンク縁切り）」の結果
  | "transferNozzle"
  | "transferIssuePump"
  | "transferMovePump"
  | "transferIssueRoute"
  | "transferMoveRoute";

/** 計算の部品（プログラムの計算を、ルールの条件として使えるようにしたもの） */
export type CalcKind = "none" | "isolation" | "flush" | "fireTest" | "transfer";

export const CALC_LABEL: Record<CalcKind, string> = {
  none: "使わない（条件だけで組み立てる）",
  isolation: "遮断範囲（燃料抜取）：対象の区間をドレン口のある区間まで広げて仕切る範囲・ドレン口・充填・液封を計算",
  flush: "循環経路（燃料末端部作業）：選んだ末端部の配管を通る、送り元タンク → ポンプ → 末端部 → 戻り先タンクの経路を計算（タンク・ポンプは点検の当日に選ぶ）",
  fireTest:
    "消火試験の範囲：試験タンクの発泡装置・冷却散水、隣接タンクの冷却散水、近くの消火栓、消火ポンプ・泡原液ポンプ、水系統・泡系統の経路、試験範囲外への仕切りを計算（下の設定で決まる）",
  transfer:
    "移送経路（タンク縁切り）：対象タンクから移送先タンクへ、払出系統（払出ポンプ → バイパス → 受入ライン）と移送系統（移送ポンプ → 受入ライン）の経路を計算し、工程ごとに経路の弁を開け・分岐先を閉め・使い終わった弁を戻す（移送先・ポンプは点検の当日に選ぶ）",
};

/** 計算の部品の設定 */
export type CalcSetting = {
  kind: CalcKind;
  /** 遮断範囲：対象区間にドレン口が無ければ、ドレン口のある区間まで広げる */
  expandToDrain: boolean;
  /** 遮断範囲：充填の時間の試算に使う流量（L/min）。抜取時間は ⑤ 燃料抜取のポンプ・ローリーの設定で計算する */
  fillLpm: number;
  /** 循環経路：循環量の目安（末端部の配管容量の何倍か）と、時間の試算に使うポンプ能力（L/min） */
  turnover: number;
  pumpLpm: number;
  transferPumpLpm: number;
  /** 消火試験の範囲：範囲の決め方（⑤ 消火設備機能試験と同じ項目）と、試験範囲外の仕切り方 */
  fire?: FireTestRules;
  fireMethod?: BlockMethod;
  /** 移送経路：払出系統で移送する工程・移送系統で移送する工程（工程名）、経路の分岐先を閉めるか、仕切り方 */
  issueStep?: string;
  moveStep?: string;
  closeSide?: boolean;
  lineupMethod?: BlockMethod;
};

export const DEFAULT_CALC: CalcSetting = {
  kind: "none",
  expandToDrain: true,
  fillLpm: 200,
  turnover: 3,
  pumpLpm: 2000,
  transferPumpLpm: 1000,
};

/** 計算の部品ごとの対象の選び方 */
export const CALC_TARGET: Record<CalcKind, CustomWorkType["target"] | null> = { none: null, isolation: "equipment", flush: "pipes", fireTest: "tank", transfer: "tank" };

/** 計算の部品ごとに使える「対象との関係」 */
export const CALC_RELATIONS: Record<CalcKind, BlockRelation[]> = {
  none: [],
  isolation: ["isoBoundary", "isoInternal", "isoDrain", "isoDrainPump", "isoFillLine", "isoFillCrack", "isoGauge", "isoBleed"],
  flush: ["flushRoute", "flushSide", "flushPump", "flushBleed"],
  fireTest: [
    "fireWater",
    "fireFoamRoute",
    "fireSprCylinder",
    "fireFoamCylinder",
    "fireHydWater",
    "fireHydFoam",
    "fireIdleOwn",
    "fireOtherFoamCyl",
    "fireOtherFoamManual",
    "fireOutside",
    "fireBleed",
    "firePump",
    "fireFoamPump",
  ],
  transfer: ["transferNozzle", "transferIssuePump", "transferMovePump", "transferIssueRoute", "transferMoveRoute"],
};

/** 計算の部品に頼らない関係 */
export const BASIC_RELATIONS: BlockRelation[] = ["any", "targetBranch", "targetOutletBranch", "onRoute", "routeBranch"];

/** 計算の部品が無いと使えない関係か */
export const needsCalc = (r: BlockRelation): CalcKind | null =>
  (Object.keys(CALC_RELATIONS) as CalcKind[]).find((k) => CALC_RELATIONS[k].includes(r)) ?? null;

/** 工程の注記に書ける、計算した値の差し込み（遮断範囲） */
export const CALC_PLACEHOLDERS: Record<CalcKind, string[]> = {
  none: [],
  isolation: ["{抜取量}", "{抜取時間}", "{充填時間}", "{ドレン口}"],
  flush: ["{送り元}", "{ポンプ}", "{戻り先}", "{循環量}", "{循環時間}", "{末端部容量}"],
  transfer: ["{対象タンク}", "{移送先}", "{払出ポンプ}", "{移送ポンプ}"],
  fireTest: ["{試験タンク}", "{消火ポンプ}", "{泡原液ポンプ}", "{発泡装置}", "{冷却散水}", "{消火栓（水）}", "{泡消火栓}", "{シリンダー弁}"],
};

export const RELATION_LABEL: Record<BlockRelation, string> = {
  any: "指定なし（系統図全体）",
  targetBranch: "対象（タンク・機器）につながる最初の弁",
  targetOutletBranch: "対象タンクに付いた設備（冷却散水・発泡装置）の枝の弁",
  onRoute: "作業の範囲・経路の上",
  routeBranch: "作業の範囲・経路から分岐する先の最初の弁",
  isoBoundary: "【遮断範囲】遮断弁（範囲を仕切る弁）",
  isoInternal: "【遮断範囲】範囲の中の弁",
  isoDrain: "【遮断範囲】抜取に使うドレン口（ドレン弁・抜取経路の弁）",
  isoDrainPump: "【遮断範囲】抜取ポンプ",
  isoFillLine: "【遮断範囲】充填ラインの弁",
  isoFillCrack: "【遮断範囲】充填ラインが無いとき微開して充填する弁",
  isoGauge: "【遮断範囲】液封の恐れがある区間の圧力計取付口",
  isoBleed: "【遮断範囲】2ブロックの間のドレン口（ブリード）",
  flushRoute: "【循環経路】経路上の弁",
  flushSide: "【循環経路】経路から分岐する先の弁",
  flushPump: "【循環経路】循環に使うポンプ",
  flushBleed: "【循環経路】2ブロックの間のドレン口（ブリード）",
  fireWater: "【消火試験】水系統の経路の弁（手動弁）",
  fireFoamRoute: "【消火試験】泡系統の経路の弁",
  fireSprCylinder: "【消火試験】使う冷却散水のシリンダー弁（隣接タンクなど）",
  fireFoamCylinder: "【消火試験】試験タンクの発泡装置のシリンダー弁",
  fireHydWater: "【消火試験】使う消火栓（水）の弁",
  fireHydFoam: "【消火試験】使う泡消火栓の弁",
  fireIdleOwn: "【消火試験】試験タンクの冷却散水のシリンダー弁（散水しないもの）",
  fireOtherFoamCyl: "【消火試験】同じヤードのほかのタンクの発泡装置のシリンダー弁",
  fireOtherFoamManual: "【消火試験】同じヤードのほかのタンクの発泡装置の手動弁",
  fireOutside: "【消火試験】試験範囲外へ分岐する弁",
  fireBleed: "【消火試験】2ブロックの間のドレン口（ブリード）",
  firePump: "【消火試験】消火ポンプ",
  fireFoamPump: "【消火試験】泡原液ポンプ",
  transferNozzle: "【移送経路】対象タンクのノズル弁（受入・払出・移送）",
  transferIssuePump: "【移送経路】払出系統で使う払出ポンプ",
  transferMovePump: "【移送経路】移送系統で使う移送ポンプ",
  transferIssueRoute: "【移送経路】払出系統の経路上の弁",
  transferMoveRoute: "【移送経路】移送系統の経路上の弁",
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
  /** 戻すのは、それまでの工程で待機状態から変わった機器だけ（変わっていなければ最後の工程は空欄） */
  restoreIfChanged?: boolean;
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
  target: "tank" | "equipment" | "pipes" | "none";
  /** 工程（「作業前」は自動で先頭に入る） */
  steps: CustomStep[];
  /** 作業の経路：条件に合う機器（最も近いもの）から対象まで。経路上・分岐先の条件と、流れの表示に使う */
  route: { enabled: boolean; from: BlockSelector; showAt: string[] };
  blocks: RuleBlock[];
  /** 計算の部品（省略時は使わない） */
  calc?: CalcSetting;
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
  fillLpm: 200,
  lorryLpm: 500,
  lorryCapacityKL: 16,
  lorryCount: 1,
};
export const DEFAULT_FLUSH_RULES: FlushRules = { turnover: 3, pumpLpm: 2000, transferPumpLpm: 1000, closeSide: true };
export const DEFAULT_ISOLATION_RULES: IsolationRules = { closeSide: true, blindNote: true };

export function drainRulesOf(rules: ChecklistRules | null | undefined): DrainRules {
  const r = rules?.drain ?? {};
  // 以前の設定（可搬ポンプ・自然流下）は使わない
  const { portableLpm: _p, gravityLpm: _g, ...rest } = r as Partial<DrainRules> & { portableLpm?: unknown; gravityLpm?: unknown };
  void _p;
  void _g;
  return { ...DEFAULT_DRAIN_RULES, ...rest };
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
  num(r.fillLpm, "充填の流量", 1, 100000, errs);
  num(r.lorryLpm, "ローリーの抜取能力", 1, 100000, errs);
  num(r.lorryCapacityKL, "ローリー1台の容量", 0.1, 1000, errs);
  num(r.lorryCount, "ローリーの台数", 1, 100, errs);
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
  const calc = t.calc?.kind ?? "none";
  if (calc === "isolation" && t.target !== "equipment") errs.push("計算の部品「遮断範囲」を使うときは、対象を「機器」にしてください");
  if (calc === "flush" && t.target !== "pipes") errs.push("計算の部品「循環経路」を使うときは、対象を「配管」にしてください");
  if (calc === "fireTest" && t.target !== "tank") errs.push("計算の部品「消火試験の範囲」を使うときは、対象を「タンク」にしてください");
  if (calc === "transfer") {
    if (t.target !== "tank") errs.push("計算の部品「移送経路」を使うときは、対象を「タンク」にしてください");
    const all = ["作業前", ...names];
    if (t.calc?.issueStep && !all.includes(t.calc.issueStep)) errs.push(`払出系統で移送する工程「${t.calc.issueStep}」がありません`);
    if (t.calc?.moveStep && !all.includes(t.calc.moveStep)) errs.push(`移送系統で移送する工程「${t.calc.moveStep}」がありません`);
  }
  if (calc !== "flush" && t.target === "pipes") errs.push("対象を「配管」にできるのは、計算の部品「循環経路」を使うときだけです");
  t.blocks.forEach((b) => {
    const need = needsCalc(b.when.relation);
    if (need && need !== calc) errs.push(`ルール「${b.name}」は計算の部品「${CALC_LABEL[need].split("：")[0]}」を使う条件です。「使う計算」で選んでください`);
  });
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
