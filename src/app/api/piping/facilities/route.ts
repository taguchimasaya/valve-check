import { requireAuth } from "@/lib/serverAuth";
import { siteAccess } from "@/lib/roles";

// 拠点（施設）の一覧。DBの piping_facilities と、それぞれの使用中の版。
// DBを読めないときは、プログラム内の仮想施設だけを返す。
// 利用者が見られる拠点だけを返す（権限のある拠点。どこかの拠点で制御室の人は、ほかの拠点も表示だけ＝viewOnly）。

const DEFAULT = { id: "virtual-airport", name: "仮想空港 給油施設（試作）", activeVersionNo: null };

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const db = auth.client;
  const { data: facilities, error } = await db.from("piping_facilities").select("*").order("id");
  const visible = <T extends { id: string }>(list: T[]) =>
    list
      .map((f) => ({ ...f, access: siteAccess(auth, f.id) }))
      .filter((f) => f.access !== "none")
      .map(({ access, ...f }) => ({ ...f, viewOnly: access === "view" }));
  if (error || !facilities?.length) return Response.json({ facilities: visible([DEFAULT]) });
  const { data: active } = await db.from("piping_diagram_versions").select("facility_id, version_no").eq("status", "active");
  const activeOf = new Map((active ?? []).map((v) => [v.facility_id as string, v.version_no as number]));
  const list = facilities
    .map((f) => ({ id: f.id as string, name: f.name as string, order: (f.sort as number | undefined) ?? 0, activeVersionNo: activeOf.get(f.id) ?? null }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((f) => ({ id: f.id, name: f.name, activeVersionNo: f.activeVersionNo }));
  if (!list.some((f) => f.id === DEFAULT.id)) list.unshift(DEFAULT);
  return Response.json({ facilities: visible(list) });
}
