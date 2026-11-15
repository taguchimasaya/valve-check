import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "@/lib/serverAuth";
import { validateDiagram, type DiagramData, type Issue } from "@/lib/piping/diagramData";

// 系統図データの版の管理API（④ 系統図データ管理）。
// GET                    … 施設の版の一覧（件数・入力チェックの件数つき）
// GET ?version=<版ID>   … 版の中身（Excel に書き出す用）
// POST {action:"import"}   … 取り込んだデータを新しい版（下書き）として登録
// POST {action:"activate"} … 下書きの版を「使用中」にする（それまでの使用中は「保管」）
// POST {action:"delete"}   … 下書きの版を削除

const DEFAULT_FACILITY = "virtual-airport";


const fail = (message: string, status = 400, extra: object = {}) => Response.json({ error: message, ...extra }, { status });

async function all<T>(c: SupabaseClient, table: string, columns: string, versionId: string, order: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.from(table).select(columns).eq("version_id", versionId).order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return rows;
  }
}

async function count(c: SupabaseClient, table: string, versionId: string, extra?: [string, unknown]) {
  let q = c.from(table).select("*", { count: "exact", head: true }).eq("version_id", versionId);
  if (extra) q = q.eq(extra[0], extra[1]);
  const { count: n } = await q;
  return n ?? 0;
}

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const params = new URL(request.url).searchParams;
  const facilityId = params.get("facility") ?? DEFAULT_FACILITY;
  const versionId = params.get("version");
  try {
    const c = auth.client;
    if (!versionId) {
      const { data, error } = await c
        .from("piping_diagram_versions")
        .select("id, version_no, status, note, effective_from, created_by, created_at")
        .eq("facility_id", facilityId)
        .order("version_no", { ascending: false });
      if (error) throw new Error(error.message);
      const versions = await Promise.all(
        (data ?? []).map(async (v) => ({
          ...v,
          nodes: await count(c, "piping_nodes", v.id),
          pipes: await count(c, "piping_pipes", v.id),
          errors: await count(c, "piping_validation_issues", v.id, ["severity", "error"]),
          warnings: await count(c, "piping_validation_issues", v.id, ["severity", "warning"]),
        }))
      );
      return Response.json({ facilityId, versions });
    }

    // 版の中身
    const { data: v, error: vErr } = await c.from("piping_diagram_versions").select("id, facility_id, note").eq("id", versionId).single();
    if (vErr) throw new Error(vErr.message);
    const { data: f } = await c.from("piping_facilities").select("id, name").eq("id", v.facility_id).single();
    const sheets = await all<{ id: string; sheet_no: string; title: string; width: number; height: number; meters_per_unit: number | null; source_document_id: string | null }>(
      c, "piping_sheets", "id, sheet_no, title, width, height, meters_per_unit, source_document_id, sort", versionId, "sort");
    const sheetNo = new Map(sheets.map((s) => [s.id, s.sheet_no]));
    const docIds = sheets.map((s) => s.source_document_id).filter((x): x is string => !!x);
    const { data: docs } = docIds.length ? await c.from("piping_source_documents").select("id, doc_no").in("id", docIds) : { data: [] };
    const docNo = new Map((docs ?? []).map((d) => [d.id, d.doc_no]));
    const [areas, nodes, symbols, pipes, geometries] = await Promise.all([
      all<Record<string, unknown>>(c, "piping_areas", "name, sheet_id, x, y, w, h, sort", versionId, "sort"),
      all<Record<string, unknown>>(c, "piping_nodes", "*", versionId, "sort"),
      all<Record<string, unknown>>(c, "piping_node_symbols", "node_code, sheet_id, x, y, rotation, show_label", versionId, "node_code"),
      all<Record<string, unknown>>(c, "piping_pipes", "*", versionId, "sort"),
      all<Record<string, unknown>>(c, "piping_pipe_geometries", "pipe_code, sheet_id, points", versionId, "pipe_code"),
    ]);
    const { data: specs, error: sErr } = await c.from("piping_pipe_specs").select("id, size_a, schedule, outer_diameter_mm, inner_diameter_mm, material").order("size_a");
    if (sErr) throw new Error(sErr.message);
    // 並び順の列は書き出さない（取り込み時は行の順に振り直す）
    const strip = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "sort" && k !== "version_id"));
    const data: DiagramData = {
      facility_id: v.facility_id,
      facility_name: f?.name ?? v.facility_id,
      note: v.note,
      sheets: sheets.map((s) => ({ sheet_no: s.sheet_no, title: s.title, width: Number(s.width), height: Number(s.height), meters_per_unit: s.meters_per_unit === null ? null : Number(s.meters_per_unit), source_doc_no: s.source_document_id ? docNo.get(s.source_document_id) ?? null : null })),
      areas: areas.map((ar) => {
        const { sheet_id, ...rest } = strip(ar);
        return { ...rest, sheet_no: sheet_id ? sheetNo.get(sheet_id as string) ?? null : null };
      }) as DiagramData["areas"],
      nodes: nodes.map(strip) as DiagramData["nodes"],
      symbols: symbols.map(({ sheet_id, ...s }) => ({ ...s, sheet_no: sheetNo.get(sheet_id as string) ?? "" })) as DiagramData["symbols"],
      pipes: pipes.map(strip) as DiagramData["pipes"],
      geometries: geometries.map(({ sheet_id, ...g }) => ({ ...g, sheet_no: sheetNo.get(sheet_id as string) ?? "" })) as DiagramData["geometries"],
      specs: (specs ?? []) as DiagramData["specs"],
    };
    return Response.json(data);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}

type Action =
  | { action: "import"; data: DiagramData; createdBy?: string; /** 取込の方法：Excel（既定）か、系統図エディタでの編集 */ method?: "excel" | "manual" }
  | { action: "activate"; versionId: string }
  | { action: "delete"; versionId: string };

async function insertChunks(c: SupabaseClient, table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await c.from(table).insert(rows.slice(i, i + 500));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const a = (await request.json()) as Action;
  const c = auth.client;
  // 取り込んだ人はログイン中の利用者（画面から送られた名前は使わない）
  if (a.action === "import") a.createdBy = auth.name;
  try {
    if (a.action === "import") {
      const d = a.data;
      const issues: Issue[] = validateDiagram(d);
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length) return fail(`入力チェックでエラーが ${errors.length} 件あります`, 400, { issues });

      // 施設（無ければ作る。図面の大きさは1枚目のシート）
      const s0 = d.sheets[0];
      const { error: fErr } = await c.from("piping_facilities").upsert({ id: d.facility_id, name: d.facility_name, width: s0.width, height: s0.height, meters_per_px: s0.meters_per_unit ?? 0 });
      if (fErr) throw new Error(fErr.message);

      const { data: last } = await c.from("piping_diagram_versions").select("version_no").eq("facility_id", d.facility_id).order("version_no", { ascending: false }).limit(1);
      const no = (last?.[0]?.version_no ?? 0) + 1;
      const versionId = `${d.facility_id}-v${no}`;
      const { error: vErr } = await c.from("piping_diagram_versions").insert({ id: versionId, facility_id: d.facility_id, version_no: no, status: "draft", note: d.note, created_by: a.createdBy ?? null });
      if (vErr) throw new Error(vErr.message);

      try {
        const { error: specErr } = await c.from("piping_pipe_specs").upsert(d.specs);
        if (specErr) throw new Error(`piping_pipe_specs: ${specErr.message}`);
        const docs = [...new Set(d.sheets.map((s) => s.source_doc_no).filter((x): x is string => !!x))].map((docNo) => ({
          id: `${d.facility_id}-${docNo}`,
          facility_id: d.facility_id,
          doc_no: docNo,
          title: d.sheets.find((s) => s.source_doc_no === docNo)!.title,
          file_type: "other",
        }));
        if (docs.length) {
          const { error } = await c.from("piping_source_documents").upsert(docs, { ignoreDuplicates: true });
          if (error) throw new Error(`piping_source_documents: ${error.message}`);
        }
        const sheetId = (no: string) => `${versionId}-${no}`;
        await insertChunks(c, "piping_sheets", d.sheets.map((s, i) => ({ id: sheetId(s.sheet_no), version_id: versionId, sheet_no: s.sheet_no, title: s.title, source_document_id: s.source_doc_no ? `${d.facility_id}-${s.source_doc_no}` : null, width: s.width, height: s.height, meters_per_unit: s.meters_per_unit, sort: i })));
        await insertChunks(c, "piping_areas", d.areas.map((ar, i) => ({ version_id: versionId, name: ar.name, sheet_id: ar.sheet_no ? sheetId(ar.sheet_no) : null, x: ar.x, y: ar.y, w: ar.w, h: ar.h, sort: i })));
        // 流体・系統は使っているときだけ送る（追加の列を作る前のDBでも、燃料だけのデータは取り込める）
        const optional = (r: object) => Object.fromEntries(Object.entries(r).filter(([k, v]) => !(["fluid", "system"].includes(k) && (v === null || v === undefined))));
        await insertChunks(c, "piping_nodes", d.nodes.map((n, i) => ({ ...optional(n), version_id: versionId, sort: i })));
        await insertChunks(c, "piping_pipes", d.pipes.map((p, i) => ({ ...optional(p), version_id: versionId, sort: i })));
        await insertChunks(c, "piping_node_symbols", d.symbols.map((s) => ({ version_id: versionId, node_code: s.node_code, sheet_id: sheetId(s.sheet_no), x: s.x, y: s.y, rotation: s.rotation ?? 0, show_label: s.show_label ?? true })));
        await insertChunks(c, "piping_pipe_geometries", d.geometries.map((g) => ({ version_id: versionId, pipe_code: g.pipe_code, sheet_id: sheetId(g.sheet_no), points: g.points })));
        await insertChunks(c, "piping_validation_issues", issues.map((i) => ({ ...i, version_id: versionId })));
        await insertChunks(c, "piping_import_batches", [{ version_id: versionId, method: a.method === "manual" ? "manual" : "excel", summary: { nodes: d.nodes.length, pipes: d.pipes.length, sheets: d.sheets.length, warnings: issues.length }, imported_by: a.createdBy ?? null }]);
      } catch (e) {
        // 途中で失敗したら、作りかけの版を消す（下の行は版の削除で一緒に消える）
        await c.from("piping_diagram_versions").delete().eq("id", versionId);
        throw e;
      }
      return Response.json({ versionId, versionNo: no, warnings: issues.length });
    }

    const { data: v, error: vErr } = await c.from("piping_diagram_versions").select("id, facility_id, status, version_no").eq("id", a.versionId).single();
    if (vErr || !v) return fail("版が見つかりません", 404);

    if (a.action === "activate") {
      if (v.status === "active") return Response.json({ ok: true });
      const { count: errs } = await c.from("piping_validation_issues").select("*", { count: "exact", head: true }).eq("version_id", v.id).eq("severity", "error").eq("resolved", false);
      if (errs) return fail("入力チェックのエラーが残っているため、使用中にできません");
      const { data: cur } = await c.from("piping_diagram_versions").select("id").eq("facility_id", v.facility_id).eq("status", "active");
      const { error: rErr } = await c.from("piping_diagram_versions").update({ status: "retired" }).eq("facility_id", v.facility_id).eq("status", "active");
      if (rErr) throw new Error(rErr.message);
      const { error: aErr } = await c.from("piping_diagram_versions").update({ status: "active", effective_from: new Date().toISOString().slice(0, 10) }).eq("id", v.id);
      if (aErr) {
        // 切り替えに失敗したら、元の使用中の版に戻す
        if (cur?.[0]) await c.from("piping_diagram_versions").update({ status: "active" }).eq("id", cur[0].id);
        throw new Error(aErr.message);
      }
      return Response.json({ ok: true });
    }

    if (a.action === "delete") {
      if (v.status !== "draft") return fail("削除できるのは下書きの版だけです（使用中・保管の版は過去の記録のために残します）");
      const { error } = await c.from("piping_diagram_versions").delete().eq("id", v.id);
      if (error) throw new Error(error.message);
      return Response.json({ ok: true });
    }
    return fail("不明な操作です");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}
