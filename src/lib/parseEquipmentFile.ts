import * as XLSX from "xlsx";

export type EquipmentRow = {
  code: string;
  name: string;
  location: string;
  valveType: string;
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
const HEADER_MAP: Record<string, keyof EquipmentRow> = {
  機器番号: "code",
  機器コード: "code",
  code: "code",
  機器名称: "name",
  機器名: "name",
  name: "name",
  設置場所: "location",
  場所: "location",
  location: "location",
  バルブ種別: "valveType",
  種別: "valveType",
  valve_type: "valveType",
};

export async function parseEquipmentFile(file: File): Promise<ParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
  });

  const valid: EquipmentRow[] = [];
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

    if (errors.length === 0) {
      valid.push({
        code: data.code!,
        name: data.name!,
        location: data.location ?? "",
        valveType: data.valveType ?? "",
      });
    } else {
      invalid.push({ rowNumber: index + 2, data, errors }); // +2: ヘッダー行+1始まり
    }
  });

  return { valid, invalid };
}

export function buildTemplateWorkbook(): XLSX.WorkBook {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["機器番号", "機器名称", "設置場所", "バルブ種別"],
    ["V-1001", "第1系統 元弁", "1号棟 1階 配管室", "仕切弁"],
    ["V-1002", "第1系統 バイパス弁", "1号棟 1階 配管室", "玉形弁"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "機器マスター");
  return workbook;
}
