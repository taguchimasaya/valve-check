import {
  blockMethodOf,
  DEFAULT_CALC,
  drainRulesOf,
  EMPTY_SELECTOR,
  fireTestRulesOf,
  fireTestSteps,
  flushRulesOf,
  isolationRulesOf,
  newRuleId,
  type BlockSelector,
  type BuiltinWorkType,
  type ChecklistRules,
  type CustomStep,
  type CustomWorkType,
  type RuleBlock,
} from "./rules";

// ユーザー定義の作業の「例」：既存の作業（燃料抜取など）の今の設定を、工程とルールブロックに置き換えたもの。
// ⑤ のユーザー定義の作業で「既存の作業をもとに作る」を押すと、これをコピーして編集できる。
// 既存の作業はプログラムで計算している部分（遮断範囲の自動拡大・液封・抜取量・当日の経路選択など）があり、
// ルールブロックで表せない部分は入らない（何が入らないかは作業の説明に書く）。

const when = (p: Partial<BlockSelector>): BlockSelector => ({ ...structuredClone(EMPTY_SELECTOR), ...p });

function block(name: string, sel: Partial<BlockSelector>, ops: RuleBlock["ops"], note = "", restore = true): RuleBlock {
  return { id: newRuleId(), name, enabled: true, when: when(sel), ops, restore, note };
}

const step = (name: string, manual: boolean, note = ""): CustomStep => ({ name, manual, note });

/** 例の種類：既存の作業4つと、消火設備の総合作動試験 */
export type TemplateKey = BuiltinWorkType | "fireIntegrated";

export const TEMPLATE_LABEL: Record<TemplateKey, string> = {
  drain: "燃料抜取",
  flush: "燃料末端部作業（循環）",
  tankIsolation: "タンク縁切り作業",
  fireTest: "消火設備機能試験",
  fireIntegrated: "消火設備総合作動試験（遠隔操作）",
};

/** 既存の作業の今の設定から、ユーザー定義の作業の例を作る */
export function templateFromBuiltin(type: TemplateKey, rules: ChecklistRules | null | undefined): CustomWorkType {
  const bm = blockMethodOf(rules);
  const base = { id: newRuleId(), route: { enabled: false, from: when({ kinds: ["pump", "transferPump"] }), showAt: [] as string[] } };
  const added = (type === "fireIntegrated" ? [] : rules?.blocks?.[type] ?? []).map((b) => ({ ...structuredClone(b), id: newRuleId() }));

  switch (type) {
    case "drain": {
      // 計算の部品「遮断範囲」を使い、プログラムの燃料抜取と同じチェックリストになる
      const r = drainRulesOf(rules);
      const two = bm.blocks === 2;
      return {
        ...base,
        name: "燃料抜取（例）",
        desc:
          "燃料抜取の設定をもとにした例です。計算の部品「遮断範囲」で範囲（ドレン口のある区間まで広げる）・ドレン口・充填・液封を計算し、" +
          "ルールで各工程の操作を決めています。プログラムの燃料抜取と同じ操作になります（作成画面での範囲の手動追加・ドレン口の除外・圧力計の選択は、この作業では行いません）。",
        target: "equipment",
        calc: { ...DEFAULT_CALC, kind: "isolation", expandToDrain: r.expandToDrain, portableLpm: r.portableLpm, fillLpm: r.fillLpm },
        steps: [
          step("ラインナップ", false, "遮断弁を閉めて抜取範囲を構成する"),
          step("抜取", true, "{ドレン口} から抜き取る（抜取量 {抜取量}・目安 {抜取時間}）"),
          step("充填", true, "燃料を戻す（目安 {充填時間}）"),
          step("復旧", false, "弁を待機状態に戻す"),
        ],
        blocks: [
          block(two ? "遮断弁を閉める（2ブロック）" : "遮断弁を閉める", { relation: "isoBoundary", kinds: ["valve"], depth: bm.blocks }, { ラインナップ: "close" }, two ? "遮断弁（2ブロック）" : "遮断弁"),
          r.openInternal
            ? block("範囲の中の閉まっている弁を開ける", { relation: "isoInternal", kinds: ["valve"], normal: "close" }, { ラインナップ: "open" }, "範囲内の弁")
            : block("範囲の中の弁は開けない（今の状態を確認）", { relation: "isoInternal", kinds: ["valve"], normal: "close" }, { ラインナップ: "close" }, "ルールにより開けない（閉を確認）", false),
          block("範囲の中の開いている弁を確認する", { relation: "isoInternal", kinds: ["valve"], normal: "open" }, { ラインナップ: "open" }, "範囲内の弁", false),
          block("ドレン口を開けて抜く", { relation: "isoDrain", kinds: ["drain", "valve"] }, { 抜取: "open", 充填: "close" }, "抜取に使うドレン", false),
          block("抜取ポンプを起動する", { relation: "isoDrainPump", kinds: ["pump", "transferPump"] }, { 抜取: "open", 充填: "close" }, "抜取工程で起動、充填工程の最初に停止", false),
          block("充填ラインの弁を開ける", { relation: "isoFillLine", kinds: ["valve"], depth: bm.blocks }, { 充填: "open" }, "充填ライン"),
          ...(r.crackFillWithoutLine
            ? [block("充填ラインが無いとき遮断弁を微開する", { relation: "isoFillCrack", kinds: ["valve"], depth: bm.blocks }, { 充填: "open" }, "充填時は微開で徐々に開く")]
            : []),
          ...(two && bm.bleed
            ? [block("2ブロックの間を抜く（ブリード）", { relation: "isoBleed", kinds: ["drain"] }, { ラインナップ: "open", 充填: "close" }, "ブリード：2ブロックの間を抜いて漏れを確認（充填前に閉）", false)]
            : []),
          { ...block("液封区間に圧力計を付ける", { relation: "isoGauge", kinds: ["gauge"] }, { ラインナップ: "open" }, "液封の監視"), enabled: false },
          ...added,
        ],
      };
    }
    case "flush": {
      // 計算の部品「循環経路」を使い、プログラムの燃料末端部作業と同じチェックリストになる
      const r = flushRulesOf(rules);
      const two = bm.blocks === 2;
      const changed = (b: RuleBlock): RuleBlock => ({ ...b, restoreIfChanged: true });
      return {
        ...base,
        name: "燃料末端部作業（例）",
        desc:
          "燃料末端部作業（循環）の設定をもとにした例です。計算の部品「循環経路」で、選んだ末端部の配管を通る 送り元タンク → ポンプ → 末端部 → 戻り先タンク の経路を計算し、" +
          "ルールで各工程の操作を決めています。プログラムの燃料末端部作業と同じ操作になります。タンク・ポンプは点検の当日に選びます。",
        target: "pipes",
        calc: { ...DEFAULT_CALC, kind: "flush", turnover: r.turnover, pumpLpm: r.pumpLpm, transferPumpLpm: r.transferPumpLpm },
        steps: [
          step("ラインナップ", false, `循環経路を構成します：{送り元} → {ポンプ} → 末端部 → {戻り先}${r.closeSide ? "（経路の分岐先の弁は閉）" : ""}`),
          step("循環", true, `{ポンプ} を起動し、{送り元} → 末端部 → {戻り先} へ循環。目標：末端部の配管容量の${r.turnover}倍 {循環量}（{循環時間}）。目標に達したら「工程完了」を押してください。`),
          step("復旧", false, "最初に {ポンプ} を停止し、循環経路の弁を元の状態に戻します。"),
        ],
        route: { ...base.route, showAt: ["循環"] },
        blocks: [
          changed(block("循環経路の弁を開ける", { relation: "flushRoute", kinds: ["valve"] }, { ラインナップ: "open" }, "循環経路")),
          ...(r.closeSide
            ? [
                changed(
                  block(
                    two ? "経路から分岐する先の弁を閉める（2ブロック）" : "経路から分岐する先の弁を閉める",
                    { relation: "flushSide", kinds: ["valve"], depth: bm.blocks },
                    { ラインナップ: "close" },
                    "経路の分岐先（燃料の回り込み防止のため閉）"
                  )
                ),
                ...(two && bm.bleed
                  ? [changed(block("2ブロックの間を抜く（ブリード）", { relation: "flushBleed", kinds: ["drain"] }, { ラインナップ: "open" }, "ブリード：2ブロックの間を抜いて漏れを確認"))]
                  : []),
              ]
            : []),
          block("循環ポンプを起動する", { relation: "flushPump", kinds: ["pump", "transferPump"] }, { 循環: "open", 復旧: "close" }, "循環工程で起動、復旧工程の最初に停止", false),
          ...added,
        ],
      };
    }
    case "tankIsolation": {
      // 計算の部品「移送経路」を使い、プログラムのタンク縁切り作業と同じチェックリストになる
      const r = isolationRulesOf(rules);
      return {
        ...base,
        name: "タンク縁切り作業（例）",
        desc:
          "タンク縁切り作業の設定をもとにした例です。計算の部品「移送経路」で、対象タンクから移送先タンクへの払出系統・移送系統の経路を計算し、工程ごとに経路の弁を開け・分岐先を閉め・使い終わった弁を戻します。" +
          "ノズル弁の閉止とポンプの起動・停止はルールで決めています。プログラムのタンク縁切り作業と同じ操作になります。移送先・ポンプは点検の当日に選びます。",
        target: "tank",
        calc: { ...DEFAULT_CALC, kind: "transfer", issueStep: "払出系統で移送", moveStep: "移送系統で移送", closeSide: r.closeSide, lineupMethod: bm },
        steps: [
          step(
            "払出系統で移送",
            true,
            `経路の弁を開け${r.closeSide ? "（分岐先は閉）" : ""}、{払出ポンプ} を起動して {対象タンク} → 払出系統 → バイパス → 受入ライン → {移送先} へ移送。払出配管で吸えなくなったら「工程完了」を押してください。`
          ),
          step(
            "移送系統で移送",
            true,
            "最初に {払出ポンプ} を停止。払出系統の弁を戻し、{移送ポンプ} を起動して {対象タンク} → 移送系統 → 受入ライン → {移送先} へ残油を移送。終わったら「工程完了」を押してください。"
          ),
          step(
            "縁切り",
            false,
            `最初に {移送ポンプ} を停止。{対象タンク} の受入・払出・移送弁をすべて閉止して縁切りし${r.blindNote ? "（必要に応じて仕切板を挿入）" : ""}、ほかの弁は元の状態に戻します。`
          ),
        ],
        blocks: [
          block("対象タンクのノズル弁を閉める", { relation: "transferNozzle", kinds: ["valve"] }, { 縁切り: "close" }, r.blindNote ? "ノズル弁（縁切りで全閉・仕切板挿入）" : "ノズル弁（縁切りで全閉）", false),
          block("払出ポンプを起動する", { relation: "transferIssuePump", kinds: ["pump"] }, { 払出系統で移送: "open", 移送系統で移送: "close" }, "払出系統で移送で起動、移送系統で移送の最初に停止", false),
          block("移送ポンプを起動する", { relation: "transferMovePump", kinds: ["transferPump"] }, { 移送系統で移送: "open", 縁切り: "close" }, "移送系統で移送で起動、縁切りの最初に停止", false),
          ...added,
        ],
      };
    }
    case "fireTest": {
      // 計算の部品「消火試験の範囲」を使い、プログラムの消火設備機能試験と同じチェックリストになる
      const r = fireTestRulesOf(rules);
      const steps = fireTestSteps(r).slice(1);
      const sprStep = r.sprinklerOpenAt === "waterStep" ? "水系統試験" : "シリンダー弁開（制御室）";
      const two = bm.blocks === 2;
      const confirm = (b: RuleBlock): RuleBlock => ({ ...b, restore: false });
      return {
        ...base,
        name: "消火設備機能試験（例）",
        desc:
          "消火設備機能試験の設定をもとにした例です。計算の部品「消火試験の範囲」で、試験タンクの発泡装置・隣接タンクの冷却散水・近くの消火栓・消火ポンプ・経路・試験範囲外への仕切りを計算し、" +
          "ルールで各工程の操作を決めています。プログラムの消火設備機能試験と同じ操作になります。",
        target: "tank",
        calc: { ...DEFAULT_CALC, kind: "fireTest", fire: r, fireMethod: bm },
        steps: steps.map((s) =>
          step(
            s,
            s.endsWith("系統試験"),
            s === "ラインナップ"
              ? "{試験タンク} の機能試験のラインナップ。試験に使う経路の弁の開、シリンダー弁・消火栓の閉を確認します。"
              : s === "シリンダー弁開（制御室）"
                ? "制御室でシリンダー弁（電磁弁）を開操作します。"
                : s === "ポンプ起動"
                  ? "取水元を確認して {消火ポンプ} を起動します。"
                  : s === "泡系統試験"
                    ? "泡系統試験：{泡原液ポンプ} を起動し、発泡装置 {発泡装置} と泡消火栓 {泡消火栓} から泡を放射します。終わったら「工程完了」を押してください。"
                    : s === "水系統試験"
                      ? "水系統試験：冷却散水 {冷却散水} の放水状況を確認し、消火栓 {消火栓（水）} を開けて放水します。終わったら「工程完了」を押してください。"
                      : s === "試験終了"
                        ? "試験終了：ポンプを停止し、シリンダー弁（制御室）・消火栓・泡系統の弁を閉めます。"
                        : "復旧：ラインナップで閉めた弁を開け、待機状態に戻します。"
          )
        ),
        route: { ...base.route, showAt: ["泡系統試験", "水系統試験", ...(r.sprinklerOpenAt === "waterStep" ? [] : ["ポンプ起動"])] },
        blocks: [
          { ...block("水系統の経路の弁を開ける（開を確認）", { relation: "fireWater", kinds: ["valve"] }, { ラインナップ: "open" }), restoreIfChanged: true },
          confirm(block("泡系統の経路の普段開の弁を確認", { relation: "fireFoamRoute", kinds: ["valve"], normal: "open" }, { ラインナップ: "open" })),
          confirm(block("泡系統の普段閉の弁を泡系統試験で開ける", { relation: "fireFoamRoute", kinds: ["valve"], normal: "close" }, { ラインナップ: "close", 泡系統試験: "open", 試験終了: "close" })),
          confirm(block("使う冷却散水のシリンダー弁を開ける", { relation: "fireSprCylinder", kinds: ["valve"] }, { ラインナップ: "close", [sprStep]: "open", 試験終了: "close" })),
          confirm(block("発泡装置のシリンダー弁を開ける", { relation: "fireFoamCylinder", kinds: ["valve"] }, { ラインナップ: "close", "シリンダー弁開（制御室）": "open", 試験終了: "close" })),
          confirm(block("消火栓（水）を開ける", { relation: "fireHydWater", kinds: ["valve"] }, { ラインナップ: "close", 水系統試験: "open", 試験終了: "close" })),
          confirm(block("泡消火栓を開ける", { relation: "fireHydFoam", kinds: ["valve"] }, { ラインナップ: "close", 泡系統試験: "open", 試験終了: "close" })),
          confirm(block("試験タンクの冷却散水のシリンダー弁の閉を確認", { relation: "fireIdleOwn", kinds: ["valve"] }, { ラインナップ: "close" })),
          confirm(block("ほかのタンクの発泡装置のシリンダー弁の閉を確認", { relation: "fireOtherFoamCyl", kinds: ["valve"] }, { ラインナップ: "close" })),
          block("ほかのタンクの発泡装置の手動弁を閉める", { relation: "fireOtherFoamManual", kinds: ["valve"] }, { ラインナップ: "close" }),
          confirm(block("試験範囲外への分岐（普段閉）の閉を確認", { relation: "fireOutside", kinds: ["valve"], normal: "close", depth: bm.blocks }, { ラインナップ: "close" })),
          block(two ? "試験範囲外への分岐（普段開）を閉める（2ブロック）" : "試験範囲外への分岐（普段開）を閉める", { relation: "fireOutside", kinds: ["valve"], normal: "open", depth: bm.blocks }, { ラインナップ: "close" }),
          block("2ブロックの間を抜く（ブリード）", { relation: "fireBleed", kinds: ["drain"] }, { ラインナップ: "open" }),
          confirm(block("消火ポンプを起動する", { relation: "firePump", kinds: ["pump"] }, { ポンプ起動: "open", 試験終了: "close" }, "ポンプ起動の工程で起動、試験終了で停止")),
          confirm(block("泡原液ポンプを起動する", { relation: "fireFoamPump", kinds: ["pump"] }, { 泡系統試験: "open", 試験終了: "close" }, "泡系統試験で起動、試験終了で停止")),
          ...added,
        ],
      };
    }
    case "fireIntegrated": {
      // 総合作動試験：遠隔操作の試験。現場で手動操作する弁は無く、手動弁は開・閉の確認だけ。範囲はタンク単位、放射は現場で確認する
      const r = fireTestRulesOf(rules);
      const confirm = (b: RuleBlock): RuleBlock => ({ ...b, restore: false });
      return {
        ...base,
        name: "消火設備総合作動試験（例）",
        desc:
          "消火設備の総合作動試験（遠隔操作）の例です。計算の部品「消火試験の範囲」で試験タンクの発泡装置・隣接タンクの冷却散水・消火ポンプ・経路を計算します。" +
          "現場で操作する弁は無いため、手動弁はライン構築で開・閉を確認するだけにし、シリンダー弁・ポンプは遠隔起動で開・起動、停止で閉・停止にしています。消火栓は機能試験と同じく使い（口数・同じヤード優先は機能試験の設定）、放射の工程で開けて放水・放射します。",
        target: "tank",
        calc: {
          ...DEFAULT_CALC,
          kind: "fireTest",
          // 遠隔操作の試験：消火栓は機能試験と同じく使う。手動で閉める仕切り・ほかのタンクの手動弁は扱わない
          fire: { ...r, closeOtherFoam: false, isolateOutside: false },
          fireMethod: { blocks: 1, bleed: false },
        },
        steps: [
          step("ライン構築", false, "{試験タンク} の総合作動試験のライン構築。経路の弁の開、シリンダー弁の閉を確認します（現場で手動操作する弁はありません）。"),
          step("遠隔起動", false, "制御室から遠隔起動します（シリンダー弁 {シリンダー弁} が開き、{消火ポンプ} が起動します）。"),
          step("起動の確認", true, "{消火ポンプ}・{泡原液ポンプ} の起動と、シリンダー弁の開を確認します。確認したら「工程完了」を押してください。"),
          step(
            "放射",
            true,
            "現場で発泡装置 {発泡装置}・冷却散水 {冷却散水} からの放射を確認し、消火栓 {消火栓（水）}・泡消火栓 {泡消火栓} を開けて放水・放射します。終わったら「工程完了」を押してください。"
          ),
          step("停止", false, "制御室から停止し（ポンプ停止・シリンダー弁閉）、消火栓を閉めます。"),
          step("復旧", false, "待機状態に戻っていることを確認します。"),
        ],
        route: { ...base.route, showAt: ["放射"] },
        blocks: [
          confirm(block("水系統の経路の弁の開を確認", { relation: "fireWater", kinds: ["valve"], normal: "open" }, { ライン構築: "open" })),
          confirm(block("泡系統の経路の弁の開を確認", { relation: "fireFoamRoute", kinds: ["valve"], normal: "open" }, { ライン構築: "open" })),
          confirm(block("遠隔起動で開く経路の弁（普段閉）", { relation: "fireFoamRoute", kinds: ["valve"], normal: "close" }, { ライン構築: "close", 遠隔起動: "open", 停止: "close" }, "遠隔起動で開（自動）")),
          confirm(block("遠隔起動で開く水系統の弁（普段閉）", { relation: "fireWater", kinds: ["valve"], normal: "close" }, { ライン構築: "close", 遠隔起動: "open", 停止: "close" }, "遠隔起動で開（自動）")),
          confirm(block("冷却散水のシリンダー弁（遠隔）", { relation: "fireSprCylinder", kinds: ["valve"] }, { ライン構築: "close", 遠隔起動: "open", 停止: "close" })),
          confirm(block("発泡装置のシリンダー弁（遠隔）", { relation: "fireFoamCylinder", kinds: ["valve"] }, { ライン構築: "close", 遠隔起動: "open", 停止: "close" })),
          confirm(block("消火栓（水）を放射で開ける", { relation: "fireHydWater", kinds: ["valve"] }, { ライン構築: "close", 放射: "open", 停止: "close" })),
          confirm(block("泡消火栓を放射で開ける", { relation: "fireHydFoam", kinds: ["valve"] }, { ライン構築: "close", 放射: "open", 停止: "close" })),
          confirm(block("試験タンクの冷却散水のシリンダー弁の閉を確認", { relation: "fireIdleOwn", kinds: ["valve"] }, { ライン構築: "close" })),
          confirm(block("ほかのタンクの発泡装置のシリンダー弁の閉を確認", { relation: "fireOtherFoamCyl", kinds: ["valve"] }, { ライン構築: "close" })),
          confirm(block("試験範囲外への分岐（普段閉）の閉を確認", { relation: "fireOutside", kinds: ["valve"], normal: "close" }, { ライン構築: "close" })),
          confirm(block("消火ポンプ（遠隔起動）", { relation: "firePump", kinds: ["pump"] }, { 遠隔起動: "open", 起動の確認: "open", 停止: "close" }, "遠隔起動で起動、停止で停止")),
          confirm(block("泡原液ポンプ（遠隔起動）", { relation: "fireFoamPump", kinds: ["pump"] }, { 遠隔起動: "open", 起動の確認: "open", 停止: "close" }, "遠隔起動で起動、停止で停止")),
        ],
      };
    }
  }
}
