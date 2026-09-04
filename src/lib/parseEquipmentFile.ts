import * as XLSX from "xlsx";

export type EquipmentRow = {
  code: string;
  name: string;
  valveType: string;
  hierarchy1: string;
  hierarchy2: string;
  hierarchy3: string;
  hierarchy4: string;
};

export type ParsedRow = {
  rowNumber: number;
  data: Partial<EquipmentRow>;
  errors: string[];
};

export type ParseResult = {
  valid: EquipmentRow[];
  invalid: ParsedRow[];
};

// 想定ヘッダー名 → 内部フィールド名。表記ゆれをある程度吸収する。
// 「設置場所」しか無い古い形式のファイルは、階層1として取り込む。
const HEADER_MAP: Record<string, keyof EquipmentRow> = {
  機器番号: "code",
  機器コード: "code",
  code: "code",
  機器名称: "name",
  機器名: "name",
  name: "name",
  バルブ種別: "valveType",
  種別: "valveType",
  valve_type: "valveType",
  階層1: "hierarchy1",
  階層2: "hierarchy2",
  階層3: "hierarchy3",
  階層4: "hierarchy4",
  設置場所: "hierarchy1",
  場所: "hierarchy1",
  location: "hierarchy1",
};

export async function parseEquipmentFile(file: File): Promise<ParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
  });

  const parsedValid: { rowNumber: number; row: EquipmentRow }[] = [];
  const invalid: ParsedRow[] = [];

  rows.forEach((row, index) => {
    const data: Partial<EquipmentRow> = {};
    for (const [header, value] of Object.entries(row)) {
      const field = HEADER_MAP[header.trim()];
      if (field) {
        data[field] = String(value ?? "").trim();
      }
    }

    const errors: string[] = [];
    if (!data.code) errors.push("機器番号が空です");
    if (!data.name) errors.push("機器名称が空です");
    const rowNumber = index + 2; // +2: ヘッダー行+1始まり

    if (errors.length === 0) {
      parsedValid.push({
        rowNumber,
        row: {
          code: data.code!,
          name: data.name!,
          valveType: data.valveType ?? "",
          hierarchy1: data.hierarchy1 ?? "",
          hierarchy2: data.hierarchy2 ?? "",
          hierarchy3: data.hierarchy3 ?? "",
          hierarchy4: data.hierarchy4 ?? "",
        },
      });
    } else {
      invalid.push({ rowNumber, data, errors });
    }
  });

  // ファイル内で機器番号が重複している場合、Supabaseへの一括更新がエラーになるため、
  // 最初の行だけを有効とし、以降の重複行は無効行として理由つきで報告する。
  const firstSeenAt = new Map<string, number>();
  parsedValid.forEach(({ rowNumber, row }) => {
    if (!firstSeenAt.has(row.code)) firstSeenAt.set(row.code, rowNumber);
  });

  const valid: EquipmentRow[] = [];
  parsedValid.forEach(({ rowNumber, row }) => {
    if (firstSeenAt.get(row.code) === rowNumber) {
      valid.push(row);
    } else {
      invalid.push({
        rowNumber,
        data: row,
        errors: [
          `機器番号「${row.code}」がファイル内の${firstSeenAt.get(row.code)}行目と重複しています`,
        ],
      });
    }
  });
  invalid.sort((a, b) => a.rowNumber - b.rowNumber);

  return { valid, invalid };
}

export function buildTemplateWorkbook(): XLSX.WorkBook {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["機器番号", "機器名称", "階層1", "階層2", "階層3", "階層4", "バルブ種別"],
    ["V-1001", "第1系統 元弁", "給油所A", "1号棟", "1階", "配管室", "仕切弁"],
    ["V-1002", "第1系統 バイパス弁", "給油所A", "1号棟", "1階", "配管室", "玉形弁"],
    ["V-2001", "第2系統 元弁", "給油所A", "2号棟", "1階", "配管室", "仕切弁"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "機器マスター");
  return workbook;
}
