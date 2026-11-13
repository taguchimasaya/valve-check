import { createClient } from "@supabase/supabase-js";
import { getFacility } from "@/lib/piping/facility";
import { rowsToFacility, type AreaRow, type DiagramPayload, type FacilityRow, type NodeRow, type PipeRow } from "@/lib/piping/diagramDb";

// 系統図データの読み込みAPI。DBの系統図テーブル（piping_diagram_*）から、施設の「使用中」の版を返す。
// テーブルが未作成・使用中の版が無いときは、プログラム内の仮想施設（サンプルと同じ内容）を返す。
// PIPING_DIAGRAM=builtin で、DBを読まずにプログラム内の仮想施設を使うこともできる。

const DEFAULT_FACILITY = "virtual-airport";
// テーブル未作成のエラー（PostgreSQL: 42P01、PostgREST: PGRST205）
const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

function builtin(notice: string): DiagramPayload {
  return { source: "builtin", facilityId: DEFAULT_FACILITY, versionId: null, versionNo: null, notice, facility: getFacility() };
}

export async function GET(request: Request) {
  const facilityId = new URL(request.url).searchParams.get("facility") ?? DEFAULT_FACILITY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (process.env.PIPING_DIAGRAM === "builtin" || !url || !key) {
    return Response.json(builtin("プログラム内の仮想施設を表示しています（DBを読まない設定）"));
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  try {
    const { data: version, error: vErr } = await db
      .from("piping_diagram_versions")
      .select("id, version_no")
      .eq("facility_id", facilityId)
      .eq("status", "active")
      .maybeSingle();
    if (vErr) {
      if (isMissingTable(vErr.code)) {
        return Response.json(
          builtin("系統図テーブルが未作成のため、プログラム内の仮想施設を表示しています（supabase/piping_diagram.sql を実行してください）")
        );
      }
      throw new Error(vErr.message);
    }
    if (!version) return Response.json(builtin(`施設「${facilityId}」に使用中の系統図の版がありません`));

    const { data: facility, error: fErr } = await db
      .from("piping_facilities")
      .select("id, name, width, height, meters_per_px")
      .eq("id", facilityId)
      .single();
    if (fErr) throw new Error(fErr.message);

    // 1回の取得は最大1000行のため、版の行を分けて読む
    async function all<T>(table: string, columns: string): Promise<T[]> {
      const rows: T[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db
          .from(table)
          .select(columns)
          .eq("version_id", version!.id)
          .order("sort")
          .range(from, from + 999);
        if (error) throw new Error(error.message);
        rows.push(...((data ?? []) as T[]));
        if (!data || data.length < 1000) return rows;
      }
    }
    const [areas, nodes, pipes] = await Promise.all([
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
      facility: rowsToFacility(facility as FacilityRow, areas, nodes, pipes),
    };
    return Response.json(payload);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
