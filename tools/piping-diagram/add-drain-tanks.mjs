// 仮想空港の系統図（登録シート Excel）に、ドレン設備を追加した Excel を作る。
//   各ヤードにドレンタンク1基（DT-1・DT-2）。ドレンタンクは各タンクのサンプリング装置（SMP-101〜206）とつながる。
//   ドレンタンクの直近にドレンポンプ（DP-1・DP-2）を置き、ドレンフィルターを通してスロップタンク（SLP-1）へ送る。
//   スロップタンクから専用のスロップ移送ポンプ（SP-1）で移送ポンプ吐出主管（既存の分岐点 J-TDD）へ戻し、メインタンクへ移送する。
// 追加する機器・配管・座標は src/lib/piping/facility.ts（プログラム内の仮想施設）と同じ。
//
// 使い方（プロジェクト直下で）:
//   1. ④ 系統図データ管理で、仮想空港の使用中の版を「Excel 書出し」する（例：仮想空港_第1版.xlsx）
//   2. node --import ./tools/tests/register.mjs tools/piping-diagram/add-drain-tanks.mjs 仮想空港_第1版.xlsx 仮想空港_ドレン設備追加.xlsx
//   3. できた Excel を ④ から取り込む（新しい下書きの版になる）→ 内容とチェックリストへの影響を確かめてから「使用中にする」
//      ※ 先に supabase/piping_diagram_v5.sql（種別「サンプリング装置」）を SQL Editor で実行しておくこと
//
// 既存の機器・配管・番号は変えない（追加だけ）。第1・第2ヤードの区画枠は、サンプリング装置まで含むよう上下に広げる。
// 新しい配管の番号は、書出しにある配管番号（P###）の続きを使う。配管仕様は、同じ呼び径の既存の配管と同じものにする。
import fs from "node:fs";
import * as XLSX from "xlsx";
import { buildFacility } from "../../src/lib/piping/facility.ts";
import { diagramToFacility, diagramToWorkbook, validateDiagram, workbookToDiagram } from "../../src/lib/piping/diagramData.ts";

/** ドレン設備として追加する機器（facility.ts の追加分） */
export const DRAIN_NODE = (id) => /^(SLP-1|V-SLPO|SP-1|CV-SP1|V-SP1D|DT-[12]|V-DT[12][OS]|DP-[12]|CV-DP[12]|FLT-DT[12]|D-FDT[12]|V-S\d{3}|SMP-\d{3}|V-SD\d{3}|J-SH\d{3})$/.test(id);
const YARD_BOX = /^第([12])ヤード（/;

/** プログラム内の仮想施設から、追加分の機器・配管と、広げた区画枠を取り出す */
export function drainAdditions() {
  const f = buildFacility();
  const nodes = f.nodes.filter((n) => DRAIN_NODE(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  const pipes = f.pipes.filter((p) => ids.has(p.a) || ids.has(p.b));
  const areas = f.areas.filter((a) => YARD_BOX.test(a.label));
  return { nodes, pipes, areas };
}

export const nodeRow = (n) => ({
  code: n.id,
  kind: n.kind,
  label: n.label,
  name: n.name,
  area: n.area,
  equipment_code: null,
  normal: n.normal ?? null,
  volume_l: n.volumeL ?? null,
  drain_size_a: n.drainSizeA ?? null,
  gauge_mountable: n.gaugeMountable ?? null,
  service: n.service ?? null,
  fill_line: n.fillLine ?? null,
  fill_source: n.fillSource ?? null,
  drain_pump_lpm: n.drainPumpLpm ?? null,
  drain_route: n.drainRoute ?? null,
  drain_target: n.drainTarget ?? null,
  drain_system: n.drainSystem ?? null,
  dir_from: n.dirFrom ?? null,
  small: n.small ?? null,
  recovery: n.recovery ?? null,
  rated_flow_lpm: null,
  capacity_kl: n.capacityKL ?? null,
  set_pressure_mpa: n.setPressureMPa ?? null,
  data_source: "ドレン設備の追加（仮の値）",
  note: null,
  fluid: null,
  system: null,
});

/** 書出しの DiagramData にドレン設備を足す（元の行は変えない） */
export function addDrainTanks(d) {
  const add = drainAdditions();
  const sheet = d.sheets[0]?.sheet_no;
  if (!sheet) throw new Error("図面シートがありません");
  const have = new Set(d.nodes.map((n) => n.code));
  const dup = add.nodes.filter((n) => have.has(n.id)).map((n) => n.id);
  if (dup.length) throw new Error(`すでにある機器番号です（追加済み？）：${dup.slice(0, 10).join("・")}`);
  for (const t of ["T-101", "T-106", "T-201", "T-206", "J-TDD"]) if (!have.has(t)) throw new Error(`タンク ${t} がありません（仮想空港の系統図ではない？）`);

  // 配管番号：既存の P### の続き
  let seq = Math.max(0, ...d.pipes.map((p) => Number(/^P(\d+)$/.exec(p.code)?.[1] ?? 0)));
  const used = new Set(d.pipes.map((p) => p.code));
  const nextCode = () => {
    let c;
    do c = `P${String(++seq).padStart(3, "0")}`;
    while (used.has(c));
    used.add(c);
    return c;
  };
  // 配管仕様：同じ呼び径の既存の配管でいちばん多いもの（無ければ空欄＝呼び径の Sch40 相当）
  const specBySize = new Map();
  const count = new Map();
  d.pipes.forEach((p) => {
    if (!p.pipe_spec_id) return;
    const k = `${p.size_a}|${p.pipe_spec_id}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  });
  [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k]) => {
      const [size, id] = k.split("|");
      if (!specBySize.has(Number(size))) specBySize.set(Number(size), id);
    });

  const nodes = [...d.nodes, ...add.nodes.map(nodeRow)];
  const symbols = [
    ...d.symbols,
    ...add.nodes.map((n) => ({ node_code: n.id, sheet_no: sheet, x: n.x, y: n.y, rotation: 0, show_label: !n.compact })),
  ];
  const pipes = [...d.pipes];
  const geometries = [...d.geometries];
  add.pipes.forEach((p) => {
    const code = nextCode();
    pipes.push({
      code,
      line_no: null,
      node_a: p.a,
      node_b: p.b,
      size_a: p.sizeA,
      pipe_spec_id: specBySize.get(p.sizeA) ?? null,
      length_m: null,
      length_source: "drawing_estimate",
      note: "ドレン設備の追加",
      fluid: null,
    });
    if (p.via?.length) geometries.push({ pipe_code: code, sheet_no: sheet, points: p.via });
  });
  // 第1・第2ヤードの区画枠を、サンプリング装置まで含むように広げる
  const areas = d.areas.map((a) => {
    const box = add.areas.find((b) => b.label === a.name);
    return box && a.sheet_no === sheet ? { ...a, x: box.x, y: box.y, w: box.w, h: box.h } : a;
  });
  return {
    ...d,
    note: [d.note, "ドレン設備（ドレンタンク DT-1・DT-2、サンプリング装置、ドレンポンプ、ドレンフィルター、スロップタンク SLP-1、スロップ移送ポンプ SP-1 と移送ラインへの戻り）を追加"].filter(Boolean).join(" ／ "),
    nodes,
    symbols,
    pipes,
    geometries,
    areas,
  };
}

// コマンドとして実行したとき
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error("使い方: node --import ./tools/tests/register.mjs tools/piping-diagram/add-drain-tanks.mjs <書出しの.xlsx> <出力.xlsx>");
    process.exit(1);
  }
  const { data, issues: readIssues } = workbookToDiagram(XLSX.read(fs.readFileSync(input)));
  if (readIssues.some((i) => i.severity === "error")) {
    console.error("読み込みのエラー:", readIssues.filter((i) => i.severity === "error").map((i) => i.message).join("\n"));
    process.exit(1);
  }
  const out = addDrainTanks(data);
  const issues = validateDiagram(out);
  const errors = issues.filter((i) => i.severity === "error");
  const before = new Set(validateDiagram(data).map((i) => i.message));
  issues.filter((i) => !before.has(i.message)).forEach((i) => console.log(`${i.severity === "error" ? "エラー" : "注意"}：${i.message}`));
  if (errors.length) process.exit(1);
  const f = diagramToFacility(out);
  fs.writeFileSync(output, XLSX.write(diagramToWorkbook(out), { type: "buffer", bookType: "xlsx" }));
  console.log(`書き出しました：${output}（機器 ${data.nodes.length} → ${out.nodes.length}、配管 ${data.pipes.length} → ${out.pipes.length}、図面の機器 ${f.nodes.length}）`);
}
