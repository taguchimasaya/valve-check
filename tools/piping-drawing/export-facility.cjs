// 配管系統図（仮想施設）の機器・配管データを JSON に書き出す（図面PDF生成用）。
// 使い方（プロジェクト直下で）:
//   npx tsc --outDir .tmp-piping --module commonjs --target es2020 --skipLibCheck src/lib/piping/facility.ts src/lib/piping/types.ts
//   node tools/piping-drawing/export-facility.cjs .tmp-piping/facility.js tools/piping-drawing/facility.json
const path = require("path");
const fs = require("fs");
const [, , compiled, out] = process.argv;
const { buildFacility } = require(path.resolve(compiled));
const f = buildFacility();
fs.writeFileSync(out, JSON.stringify(f, null, 1), "utf8");
console.log(`nodes ${f.nodes.length}, pipes ${f.pipes.length} -> ${out}`);
