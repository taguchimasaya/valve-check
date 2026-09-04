import * as XLSX from "xlsx";

export type ChecklistItemRow = {
  itemNo: number;
  itemName: string;
  criteria: string;
};

export type ChecklistParsedRow = {
  rowNumber: number;
  data: { itemName?: string; criteria?: string };
  errors: string[];
};

export type ChecklistParseResult = {
  valid: ChecklistItemRow[];
  invalid: ChecklistParsedRow[];
};

const HEADER_MAP: Record<string, "itemNo" | "itemName" | "criteria"> = {
  項目番号: "itemNo",
  番号: "itemNo",
  no: "itemNo",
  点検項目: "itemName",
  項目: "itemName",
  チェック項目: "itemName",
  item: "itemName",
  判定基準: "criteria",
  基準: "criteria",
  criteria: "criteria",
};

export async function parseChecklistFile(file: File): Promise<ChecklistParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
  });

  const valid: ChecklistItemRow[] = [];
  const invalid: ChecklistParsedRow[] = [];
  let autoNo = 1;

  rows.forEach((row, index) => {
    const data: { itemNo?: string; itemName?: string; criteria?: string } = {};
    for (const [header, value] of Object.entries(row)) {
      const field = HEADER_MAP[header.trim()];
      if (field) {
        data[field] = String(value ?? "").trim();
      }
    }

    const rowNumber = index + 2;
    if (!data.itemName) {
      invalid.push({
        rowNumber,
        data: { itemName: data.itemName, criteria: data.criteria },
        errors: ["点検項目が空です"],
      });
      return;
    }

    const itemNo = data.itemNo ? Number(data.itemNo) : autoNo;
    if (data.itemNo && Number.isNaN(itemNo)) {
      invalid.push({
        rowNumber,
        data: { itemName: data.itemName, criteria: data.criteria },
        errors: ["項目番号が数値ではありません"],
      });
      return;
    }

    valid.push({ itemNo, itemName: data.itemName, criteria: data.criteria ?? "" });
    autoNo = itemNo + 1;
  });

  return { valid, invalid };
}

export function buildChecklistTemplateWorkbook(): XLSX.WorkBook {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["項目番号", "点検項目", "判定基準"],
    [1, "外観に損傷・変形がないこと", "亀裂・著しい腐食がないこと"],
    [2, "弁からの漏れがないこと", "本体・グランド部からの油漏れがないこと"],
    [3, "開閉操作に異常がないこと", "軽い力でスムーズに全開〜全閉できること"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "チェックリスト");
  return workbook;
}
