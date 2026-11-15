import { requireAuth, requireSite } from "@/lib/serverAuth";
import { getFacility } from "@/lib/piping/facility";
import {
  rowsToFacility,
  rowsToFacilityV2,
  type AreaRow,
  type AreaRowV2,
  type DiagramPayload,
  type FacilityRow,
  type GeometryRow,
  type NodeRow,
  type NodeRowV2,
  type PipeRow,
  type PipeRowV2,
  type PipeSpecRow,
  type SheetRow,
  type SymbolRow,
} from "@/lib/piping/diagramDb";

// 系統図データの読み込みAPI。DBから、施設の「使用中」の版を返す。
// 読む順：本番想定の構造（piping_nodes・piping_sheets など）→ 第1版の構造（piping_diagram_nodes など）→ プログラム内の仮想施設。
// PIPING_DIAGRAM=builtin で、DBを読まずにプログラム内の仮想施設を使うこともできる。

const DEFAULT_FACILITY = "virtual-airport";
// テーブル未作成のエラー（PostgreSQL: 42P01、PostgREST: PGRST205）
const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

function builtin(notice: string): DiagramPayload {
  return { source: "builtin", facilityId: DEFAULT_FACILITY, versionId: null, versionNo: null, notice, facility: getFacility() };
}

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const params = new URL(request.url).searchParams;
  const facilityId = params.get("facility") ?? DEFAULT_FACILITY;
  const site = requireSite(auth, facilityId);
  if (site instanceof Response) return site;
  // version を指定すると、その版（下書き・保管を含む）を返す（④ 系統図データ管理のプレビュー用）
  const versionParam = params.get("version");
  if (process.env.PIPING_DIAGRAM === "builtin") {
    return Response.json(builtin("プログラム内の仮想施設を表示しています（DBを読まない設定）"));
  }
  const db = auth.client;
  try {
    const base = db.from("piping_diagram_versions").select("id, version_no");
    const { data: version, error: vErr } = await (versionParam
      ? base.eq("id", versionParam)
      : base.eq("facility_id", facilityId).eq("status", "active")
    ).maybeSingle();
    if (vErr) {
      if (isMissingTable(vErr.code)) {
        return Response.json(
          builtin("系統図テーブルが未作成のため、プログラム内の仮想施設を表示しています（supabase/piping_diagram.sql を実行してください）")
        );
      }
      throw new Error(vErr.message);
    }
    if (!version) {
      if (facilityId === DEFAULT_FACILITY && !versionParam) {
        return Response.json(builtin(`施設「${facilityId}」に使用中の系統図の版がありません`));
      }
      // ほかの拠点：使用中の版が無ければ空の図面（④ 系統図データ管理で取り込んで使用中にする）
      const { data: fac } = await db.from("piping_facilities").select("name").eq("id", facilityId).maybeSingle();
      const empty: DiagramPayload = {
        source: "none",
        facilityId,
        versionId: null,
        versionNo: null,
        notice: "この拠点には使用中の系統図がありません。④ 系統図データ管理で取り込んで「使用中にする」を押してください。",
        facility: { name: fac?.name ?? facilityId, width: 1200, height: 700, metersPerPx: 0, nodes: [], pipes: [], areas: [] },
      };
      return Response.json(empty);
    }

    const { data: facility, error: fErr } = await db
      .from("piping_facilities")
      .select("id, name, width, height, meters_per_px")
      .eq("id", facilityId)
      .single();
    if (fErr) throw new Error(fErr.message);

    // 1回の取得は最大1000行のため、版の行を分けて読む（テーブルが無ければ null）
    async function all<T>(table: string, columns: string, filter?: { col: string; value: string }, order = "sort"): Promise<T[] | null> {
      const rows: T[] = [];
      for (let from = 0; ; from += 1000) {
        let query = db.from(table).select(columns).eq("version_id", version!.id);
        if (filter) query = query.eq(filter.col, filter.value);
        const { data, error } = await query.order(order).range(from, from + 999);
        if (error) {
          if (isMissingTable(error.code)) return null;
          throw new Error(error.message);
        }
        rows.push(...((data ?? []) as T[]));
        if (!data || data.length < 1000) return rows;
      }
    }

    // 本番想定の構造：論理データ（機器・配管）＋ 1枚目の図面シートの図面データ
    const sheets = await all<SheetRow>("piping_sheets", "id, sheet_no, title, width, height, meters_per_unit");
    if (sheets?.length) {
      const sheet = sheets[0];
      const [areas, nodes, symbols, pipes, geometries] = await Promise.all([
        all<AreaRowV2>("piping_areas", "name, sheet_id, x, y, w, h, sort"),
        // 追加の列（流体・系統など）があっても無くても読めるよう、すべての列を読む
        all<NodeRowV2>("piping_nodes", "*"),
        all<SymbolRow>("piping_node_symbols", "node_code, x, y, show_label", { col: "sheet_id", value: sheet.id }, "node_code"),
        all<PipeRowV2>("piping_pipes", "*"),
        all<GeometryRow>("piping_pipe_geometries", "pipe_code, points", { col: "sheet_id", value: sheet.id }, "pipe_code"),
      ]);
      const { data: specs, error: sErr } = await db.from("piping_pipe_specs").select("id, inner_diameter_mm");
      if (sErr) throw new Error(sErr.message);
      const { facility: built, unplaced } = rowsToFacilityV2(
        (facility as FacilityRow).name,
        sheet,
        areas ?? [],
        nodes ?? [],
        symbols ?? [],
        pipes ?? [],
        geometries ?? [],
        (specs ?? []) as PipeSpecRow[]
      );
      const payload: DiagramPayload = {
        source: "db",
        facilityId,
        versionId: version.id,
        versionNo: version.version_no,
        sheet: `${sheet.sheet_no} ${sheet.title}`,
        sheetCount: sheets.length,
        ...(unplaced ? { notice: `図面シート ${sheet.sheet_no} に位置が無い機器が ${unplaced} 件あります（左上に表示）` } : {}),
        facility: built,
      };
      return Response.json(payload);
    }

    // 第1版の構造（座標を機器の行に持つ）
    const [areasV1, nodesV1, pipesV1] = await Promise.all([
      all<AreaRow>("piping_diagram_areas", "name, x, y, w, h, sort"),
      all<NodeRow>(
        "piping_diagram_nodes",
        "code, kind, label, name, area, x, y, normal, volume_l, drain_size_a, gauge_mountable, service, fill_line, fill_source, drain_pump_lpm, drain_route, drain_target, drain_system, dir_from, small, recovery, compact, capacity_kl, set_pressure_mpa, sort"
      ),
      all<PipeRow>("piping_diagram_pipes", "code, node_a, node_b, size_a, length_m, via, sort"),
    ]);
    const payload: DiagramPayload = {
      source: "db",
      facilityId,
      versionId: version.id,
      versionNo: version.version_no,
      facility: rowsToFacility(facility as FacilityRow, areasV1 ?? [], nodesV1 ?? [], pipesV1 ?? []),
    };
    return Response.json(payload);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
