// 仮想施設の系統図（src/lib/piping/facility.ts）を、DBのサンプルデータ（SQL）として書き出す。
// 使い方（プロジェクト直下で）:
//   npx tsc --outDir .tmp-piping --module commonjs --target es2020 --skipLibCheck src/lib/piping/facility.ts src/lib/piping/types.ts
//   node tools/piping-diagram/generate-seed.cjs .tmp-piping/facility.js supabase/piping_diagram_seed.sql
const path = require("path");
const fs = require("fs");

const [, , compiled, out] = process.argv;
const { buildFacility } = require(path.resolve(compiled));
const f = buildFacility();

const FACILITY_ID = "virtual-airport";
const VERSION_ID = "virtual-airport-v1";

const q = (v) => (v === undefined || v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const n = (v) => (v === undefined || v === null ? "null" : String(v));
const b = (v) => (v === undefined || v === null ? "null" : v ? "true" : "false");
const arr = (v) => (v && v.length ? `array[${v.map(q).join(", ")}]::text[]` : "null");
const json = (v) => (v && v.length ? `${q(JSON.stringify(v))}::jsonb` : "null");

const lines = [];
const push = (s) => lines.push(s);

push("-- 配管系統図のサンプルデータ（仮想空港給油施設・第1版）");
push("-- 先に supabase/piping_diagram.sql を実行してから、このファイルを SQL Editor で実行してください。");
push("-- 何度実行しても同じ内容に入れ替わります（第1版の機器・配管・区画を削除して入れ直す）。");
push("-- このファイルは tools/piping-diagram/generate-seed.cjs で src/lib/piping/facility.ts から生成しています。");
push("");
push("begin;");
push("");
push(
  `insert into piping_facilities (id, name, width, height, meters_per_px) values (${q(FACILITY_ID)}, ${q(f.name)}, ${n(f.width)}, ${n(f.height)}, ${n(f.metersPerPx)})`
);
push("  on conflict (id) do update set name = excluded.name, width = excluded.width, height = excluded.height, meters_per_px = excluded.meters_per_px;");
push("");
push(`update piping_diagram_versions set status = 'retired' where facility_id = ${q(FACILITY_ID)} and id <> ${q(VERSION_ID)} and status = 'active';`);
push(
  `insert into piping_diagram_versions (id, facility_id, version_no, status, note, effective_from, created_by) values (${q(VERSION_ID)}, ${q(FACILITY_ID)}, 1, 'active', ${q("試作の仮想施設（サンプルデータ）")}, current_date, ${q("サンプル")})`
);
push("  on conflict (id) do update set status = 'active', note = excluded.note;");
push("");
push(`delete from piping_diagram_pipes where version_id = ${q(VERSION_ID)};`);
push(`delete from piping_diagram_nodes where version_id = ${q(VERSION_ID)};`);
push(`delete from piping_diagram_areas where version_id = ${q(VERSION_ID)};`);
push("");

push("insert into piping_diagram_areas (version_id, name, x, y, w, h, sort) values");
push(f.areas.map((a, i) => `  (${q(VERSION_ID)}, ${q(a.label)}, ${n(a.x)}, ${n(a.y)}, ${n(a.w)}, ${n(a.h)}, ${i})`).join(",\n") + ";");
push("");

const nodeCols = [
  "version_id", "code", "kind", "label", "name", "area", "x", "y", "normal", "volume_l", "drain_size_a",
  "gauge_mountable", "service", "fill_line", "fill_source", "drain_pump_lpm", "drain_route", "drain_target",
  "drain_system", "dir_from", "small", "recovery", "compact", "capacity_kl", "set_pressure_mpa", "sort",
];
const nodeRow = (x, i) =>
  [
    q(VERSION_ID), q(x.id), q(x.kind), q(x.label ?? ""), q(x.name), q(x.area), n(x.x), n(x.y), q(x.normal),
    n(x.volumeL), n(x.drainSizeA), b(x.gaugeMountable), b(x.service), b(x.fillLine), b(x.fillSource),
    n(x.drainPumpLpm), arr(x.drainRoute), q(x.drainTarget), q(x.drainSystem), q(x.dirFrom), b(x.small),
    b(x.recovery), b(x.compact), n(x.capacityKL), n(x.setPressureMPa), i,
  ].join(", ");
// 1文が大きくなりすぎないよう 200 行ずつに分ける
for (let i = 0; i < f.nodes.length; i += 200) {
  push(`insert into piping_diagram_nodes (${nodeCols.join(", ")}) values`);
  push(f.nodes.slice(i, i + 200).map((x, k) => `  (${nodeRow(x, i + k)})`).join(",\n") + ";");
  push("");
}

const pipeCols = ["version_id", "code", "node_a", "node_b", "size_a", "length_m", "via", "sort"];
for (let i = 0; i < f.pipes.length; i += 200) {
  push(`insert into piping_diagram_pipes (${pipeCols.join(", ")}) values`);
  push(
    f.pipes
      .slice(i, i + 200)
      .map((p, k) => `  (${[q(VERSION_ID), q(p.id), q(p.a), q(p.b), n(p.sizeA), n(p.lengthM), json(p.via), i + k].join(", ")})`)
      .join(",\n") + ";"
  );
  push("");
}

push("commit;");
push("");
push(`-- 機器 ${f.nodes.length} 件・配管 ${f.pipes.length} 件・区画 ${f.areas.length} 件`);
fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");
console.log(`nodes ${f.nodes.length}, pipes ${f.pipes.length}, areas ${f.areas.length} -> ${out}`);
