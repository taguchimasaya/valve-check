import { useMemo, useState } from "react";

export type HierarchyLevels = {
  hierarchy1: string | null;
  hierarchy2: string | null;
  hierarchy3: string | null;
  hierarchy4: string | null;
};

function uniqueSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort(
    (a, b) => a.localeCompare(b, "ja")
  );
}

// 階層1〜4を上から順に絞り込む(上位を変えたら下位の選択はリセット)カスケードフィルター。
export function useHierarchyFilter<T extends HierarchyLevels>(items: T[]) {
  const [h1, setH1Raw] = useState("");
  const [h2, setH2Raw] = useState("");
  const [h3, setH3Raw] = useState("");
  const [h4, setH4] = useState("");

  const setH1 = (v: string) => {
    setH1Raw(v);
    setH2Raw("");
    setH3Raw("");
    setH4("");
  };
  const setH2 = (v: string) => {
    setH2Raw(v);
    setH3Raw("");
    setH4("");
  };
  const setH3 = (v: string) => {
    setH3Raw(v);
    setH4("");
  };

  const afterH1 = useMemo(
    () => (h1 ? items.filter((i) => i.hierarchy1 === h1) : items),
    [items, h1]
  );
  const afterH2 = useMemo(
    () => (h2 ? afterH1.filter((i) => i.hierarchy2 === h2) : afterH1),
    [afterH1, h2]
  );
  const afterH3 = useMemo(
    () => (h3 ? afterH2.filter((i) => i.hierarchy3 === h3) : afterH2),
    [afterH2, h3]
  );
  const filtered = useMemo(
    () => (h4 ? afterH3.filter((i) => i.hierarchy4 === h4) : afterH3),
    [afterH3, h4]
  );

  const options1 = useMemo(() => uniqueSorted(items.map((i) => i.hierarchy1)), [items]);
  const options2 = useMemo(() => uniqueSorted(afterH1.map((i) => i.hierarchy2)), [afterH1]);
  const options3 = useMemo(() => uniqueSorted(afterH2.map((i) => i.hierarchy3)), [afterH2]);
  const options4 = useMemo(() => uniqueSorted(afterH3.map((i) => i.hierarchy4)), [afterH3]);

  // データ全体でそのレベルが1件も使われていなければ、その階層フィルターは表示しない
  const hasLevel2 = useMemo(() => items.some((i) => i.hierarchy2), [items]);
  const hasLevel3 = useMemo(() => items.some((i) => i.hierarchy3), [items]);
  const hasLevel4 = useMemo(() => items.some((i) => i.hierarchy4), [items]);

  return {
    h1,
    h2,
    h3,
    h4,
    setH1,
    setH2,
    setH3,
    setH4,
    options1,
    options2,
    options3,
    options4,
    hasLevel2,
    hasLevel3,
    hasLevel4,
    filtered,
  };
}
