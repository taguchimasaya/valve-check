import * as XLSX from "xlsx";

export type TargetState = "open" | "close";

export type RequiredStep = { stepIndex: number; target: TargetState };

export type ProcedureRow = {
  rowNumber: number;
  equipmentCode: string;
  requiredSteps: RequiredStep[];
};

export type ProcedureRowError = {
  rowNumber: number;
  message: string;
};

export type ProcedureParseResult = {
  steps: string[];
  rows: ProcedureRow[];
  errors: ProcedureRowError[];
};

// これらのマークは「対象外（＝その工程でこのバルブは操作しない）」を意味する。
const NA_MARKERS = new Set(["／", "/", "-", "－", "ー", "―", "対象外", "na", "n/a"]);

// ☓系のマークは「閉」を表す。それ以外の（対象外ではない）マークは「開」として扱う。
const CLOSE_MARKERS = new Set(["☓", "×", "x", "✕", "close", "閉"]);

// 「操作者」「制御室」列は工程ごとの確認欄（誰が確認したかの記録用）で、
// 現場のQRスキャン／制御室の確認ボタンでアプリ側が自動的に記録するため、
// 手順の定義としては読み飛ばす。
const SKIP_COLUMN_HEADERS = new Set(["操作者", "制御室"]);

function cellState(value: unknown): TargetState | "na" {
  const text = String(value ?? "").trim();
  if (!text) return "na";
  const lower = text.toLowerCase();
  if (NA_MARKERS.has(text) || NA_MARKERS.has(lower)) return "na";
  if (CLOSE_MARKERS.has(text) || CLOSE_MARKERS.has(lower)) return "close";
  return "open";
}

export async function parseProcedureChecklistFile(
  file: File
): Promise<ProcedureParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
  });

  if (rows.length === 0) {
    return { steps: [], rows: [], errors: [] };
  }

  const headerRow = rows[0];

  // (元の列インデックス, 工程名) の組。「操作者」「制御室」列と空欄列は除く。
  const stepColumns: { colIndex: number; name: string }[] = [];
  headerRow.forEach((cell, colIndex) => {
    if (colIndex === 0) return; // 1列目はバルブ名
    const name = String(cell ?? "").trim();
    if (!name || SKIP_COLUMN_HEADERS.has(name)) return;
    stepColumns.push({ colIndex, name });
  });

  const steps = stepColumns.map((c) => c.name);

  const parsedRows: ProcedureRow[] = [];
  const errors: ProcedureRowError[] = [];

  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2; // ヘッダー行+1始まり
    const equipmentCode = String(row[0] ?? "").trim();
    if (!equipmentCode) return; // 空行はスキップ

    const requiredSteps: RequiredStep[] = [];
    stepColumns.forEach(({ colIndex }, stepIndex) => {
      const state = cellState(row[colIndex]);
      if (state !== "na") {
        requiredSteps.push({ stepIndex, target: state });
      }
    });

    if (requiredSteps.length === 0) {
      errors.push({
        rowNumber,
        message: `機器番号「${equipmentCode}」はどの工程にも印がありません`,
      });
      return;
    }

    parsedRows.push({ rowNumber, equipmentCode, requiredSteps });
  });

  return { steps, rows: parsedRows, errors };
}

export type ProcedureExportRow = {
  equipmentCode: string;
  requiredSteps: RequiredStep[];
};

// 登録済みチェックリストを、取込時と同じ「バルブ×工程表」形式で書き出す。
// 操作者・制御室の確認欄は空欄のまま出力する（記録はアプリ内のデータとして保持されるため）。
export function buildProcedureExportWorkbook(
  steps: string[],
  rows: ProcedureExportRow[]
): XLSX.WorkBook {
  const header: string[] = ["バルブ名"];
  steps.forEach((step) => {
    header.push(step, "操作者", "制御室");
  });

  const aoa: (string | number)[][] = [header];
  rows.forEach((row) => {
    const stateByIndex = new Map(row.requiredSteps.map((s) => [s.stepIndex, s.target]));
    const line: (string | number)[] = [row.equipmentCode];
    steps.forEach((_, i) => {
      const state = stateByIndex.get(i);
      line.push(state === "close" ? "☓" : state === "open" ? "○" : "／", "", "");
    });
    aoa.push(line);
  });

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "作業手順");
  return workbook;
}

export function buildProcedureTemplateWorkbook(): XLSX.WorkBook {
  const sheet = XLSX.utils.aoa_to_sheet([
    [
      "バルブ名",
      "作業前",
      "作業工程１",
      "操作者",
      "制御室",
      "作業工程２",
      "操作者",
      "制御室",
      "作業後",
      "操作者",
      "制御室",
    ],
    ["V-1001", "☓", "○", "", "", "○", "", "", "○", "", ""],
    ["V-1002", "○", "○", "", "", "☓", "", "", "☓", "", ""],
    ["V-1003", "○", "／", "", "", "☓", "", "", "☓", "", ""],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "作業手順");
  return workbook;
}
