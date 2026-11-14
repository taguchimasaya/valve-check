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

export type ChecklistRules = {
  fireTest?: Partial<FireTestRules>;
  updatedAt?: string;
};

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
