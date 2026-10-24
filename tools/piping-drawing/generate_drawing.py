"""仮想空港給油施設の配管系統図（P&ID）を、CAD図面風の PDF として出力する。

配管系統図アプリの「下絵」機能の試用・デモ用。export-facility.cjs で書き出した JSON から描く。
あわせて、図面と系統図アプリの座標の対応（下絵の位置合わせ情報）を JSON で出力する。

使い方（プロジェクト直下で）:
  python tools/piping-drawing/generate_drawing.py tools/piping-drawing/facility.json public/drawings
"""

import json
import math
import sys
from pathlib import Path

from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT = "MSGothic"
pdfmetrics.registerFont(TTFont(FONT, "C:/Windows/Fonts/msgothic.ttc", subfontIndex=0))

PAGE_W, PAGE_H = 841 * mm, 594 * mm  # A1 横
MARGIN = 12 * mm
TITLE_H = 38 * mm


def main(src: str, out_dir: str):
    f = json.loads(Path(src).read_text(encoding="utf8"))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    nodes = {n["id"]: n for n in f["nodes"]}
    pipes = f["pipes"]
    adj: dict[str, list] = {n: [] for n in nodes}
    for p in pipes:
        adj[p["a"]].append(p)
        adj[p["b"]].append(p)

    # 系統図アプリの座標 → 図面上の位置（縦横比を保って枠内に収める）
    area_w = PAGE_W - 2 * MARGIN - 20 * mm
    area_h = PAGE_H - 2 * MARGIN - TITLE_H - 20 * mm
    s = min(area_w / f["width"], area_h / f["height"])
    ox = MARGIN + 10 * mm + (area_w - f["width"] * s) / 2
    top = MARGIN + 10 * mm + (area_h - f["height"] * s) / 2  # 用紙上端からの距離

    def X(x):
        return ox + x * s

    def Y(y):
        return PAGE_H - (top + y * s)

    def pts(p):
        a, b = nodes[p["a"]], nodes[p["b"]]
        return [(a["x"], a["y"]), *[tuple(v) for v in p.get("via", [])], (b["x"], b["y"])]

    c = canvas.Canvas(str(out / "virtual-airport-piping.pdf"), pagesize=(PAGE_W, PAGE_H))
    c.setTitle("仮想空港給油施設 配管系統図")
    c.setAuthor("valve-check（試作）")

    # ── 図枠・区画記号 ──
    c.setLineWidth(1.2)
    c.rect(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN)
    c.setLineWidth(0.4)
    inner = 6 * mm
    c.rect(MARGIN + inner, MARGIN + inner, PAGE_W - 2 * (MARGIN + inner), PAGE_H - 2 * (MARGIN + inner))
    c.setFont(FONT, 9)
    cols, rows = 12, 8
    for i in range(cols):
        cx = MARGIN + inner + (PAGE_W - 2 * (MARGIN + inner)) * (i + 0.5) / cols
        c.drawCentredString(cx, PAGE_H - MARGIN - 4.5 * mm, str(i + 1))
        c.drawCentredString(cx, MARGIN + 2 * mm, str(i + 1))
    for j in range(rows):
        cy = PAGE_H - (MARGIN + inner) - (PAGE_H - 2 * (MARGIN + inner)) * (j + 0.5) / rows
        c.drawCentredString(MARGIN + 3 * mm, cy - 1.5 * mm, "ABCDEFGH"[j])
        c.drawCentredString(PAGE_W - MARGIN - 3 * mm, cy - 1.5 * mm, "ABCDEFGH"[j])

    # ── 区画（一点鎖線）──
    c.setDash([6, 2, 1, 2])
    c.setLineWidth(0.35)
    c.setFont(FONT, 11 * s)
    for a in f["areas"]:
        c.rect(X(a["x"]), Y(a["y"] + a["h"]), a["w"] * s, a["h"] * s)
        c.drawString(X(a["x"]) + 2 * mm, Y(a["y"]) - 4 * mm, a["label"])
    c.setDash()

    # ── 配管 ──
    c.setStrokeColorRGB(0, 0, 0)
    for p in pipes:
        c.setLineWidth(max(0.25, 0.2 + p["sizeA"] / 260))
        path = c.beginPath()
        ps = pts(p)
        path.moveTo(X(ps[0][0]), Y(ps[0][1]))
        for q in ps[1:]:
            path.lineTo(X(q[0]), Y(q[1]))
        c.drawPath(path, stroke=1, fill=0)

    # ── 機器記号 ──
    def neighbor_dir(n, toward=None):
        """ノードにつながる配管の向き（単位ベクトル）。toward を指定するとその隣接ノード側。"""
        for p in adj[n["id"]]:
            other = p["b"] if p["a"] == n["id"] else p["a"]
            if toward is not None and other != toward:
                continue
            ps = pts(p)
            near = ps[1] if p["a"] == n["id"] else ps[-2]
            dx, dy = near[0] - n["x"], near[1] - n["y"]
            d = math.hypot(dx, dy) or 1
            return dx / d, dy / d
        return 1.0, 0.0

    def downstream(n):
        if not n.get("dirFrom"):
            return neighbor_dir(n)
        for p in adj[n["id"]]:
            other = p["b"] if p["a"] == n["id"] else p["a"]
            if other != n["dirFrom"]:
                return neighbor_dir(n, other)
        return 1.0, 0.0

    def poly(points, fill=1):
        path = c.beginPath()
        path.moveTo(*points[0])
        for q in points[1:]:
            path.lineTo(*q)
        path.close()
        c.drawPath(path, stroke=1, fill=fill)

    def label(text, x, y, size=7.5, anchor="left"):
        c.setFillColorRGB(0, 0, 0)
        c.setFont(FONT, size * s * 1.25)
        if anchor == "center":
            c.drawCentredString(x, y, text)
        else:
            c.drawString(x, y, text)

    c.setLineWidth(0.35)
    for n in f["nodes"]:
        k, x, y = n["kind"], X(n["x"]), Y(n["y"])
        c.setStrokeColorRGB(0, 0, 0)
        c.setFillColorRGB(1, 1, 1)
        if k == "junction":
            if len(adj[n["id"]]) >= 3:
                c.setFillColorRGB(0, 0, 0)
                c.circle(x, y, 1.1 * s * 2, stroke=0, fill=1)
        elif k == "valve":
            dx, dy = neighbor_dir(n)
            h = abs(dx) >= abs(dy)
            a, b = 8 * s, 5.6 * s
            if h:
                poly([(x - a, y + b), (x + a, y - b), (x + a, y + b), (x - a, y - b)])
                label(n["label"], x, y + 9 * s, anchor="center")
            else:
                poly([(x - b, y + a), (x + b, y - a), (x - b, y - a), (x + b, y + a)])
                label(n["label"], x + 9 * s, y - 2.5 * s)
        elif k == "check":
            dx, dy = downstream(n)
            ang = math.atan2(-dy, dx)
            r = lambda px, py: (x + px * math.cos(ang) - py * math.sin(ang), y + px * math.sin(ang) + py * math.cos(ang))
            poly([r(-7 * s, -6 * s), r(5 * s, 0), r(-7 * s, 6 * s)])
            c.line(*r(6 * s, -7 * s), *r(6 * s, 7 * s))
        elif k in ("pump", "transferPump"):
            dx, dy = downstream(n)
            ang = math.atan2(-dy, dx)
            c.circle(x, y, 15 * s, stroke=1, fill=1)
            r = lambda px, py: (x + px * math.cos(ang) - py * math.sin(ang), y + px * math.sin(ang) + py * math.cos(ang))
            c.setFillColorRGB(0, 0, 0)
            poly([r(-7 * s, -8 * s), r(9 * s, 0), r(-7 * s, 8 * s)])
            label(n["label"], x, y - 26 * s, size=9, anchor="center")
        elif k == "strainer":
            c.rect(x - 13 * s, y - 10 * s, 26 * s, 20 * s, stroke=1, fill=1)
            c.line(x - 8 * s, y + 6 * s, x + 8 * s, y - 6 * s)
            c.line(x - 8 * s, y - 6 * s, x + 8 * s, y + 6 * s)
            label(n["label"], x, y + 13 * s, anchor="center")
        elif k == "filter":
            c.roundRect(x - 15 * s, y - 20 * s, 30 * s, 40 * s, 9 * s, stroke=1, fill=1)
            label("F", x, y - 3 * s, size=10, anchor="center")
            label(n["label"], x, y + 23 * s, anchor="center")
        elif k == "psv":
            c.rect(x - 7 * s, y - 9 * s, 14 * s, 18 * s, stroke=1, fill=1)
            path = c.beginPath()
            path.moveTo(x - 4 * s, y + 5 * s)
            for i, (px, py) in enumerate([(4, 2), (-4, -1), (4, -4)]):
                path.lineTo(x + px * s, y + py * s)
            c.drawPath(path, stroke=1, fill=0)
            if not n.get("compact"):
                label(n["label"], x + 10 * s, y - 2.5 * s)
        elif k == "drain":
            poly([(x - 6 * s, y + 5 * s), (x + 6 * s, y + 5 * s), (x, y - 5 * s)])
            label(n["label"], x + 8 * s, y - 2.5 * s, size=7)
        elif k == "gauge":
            c.circle(x, y, 7 * s, stroke=1, fill=1)
            c.line(x, y, x + 4 * s, y + 4 * s)
            label(n["label"], x + 10 * s, y - 2.5 * s, size=7)
        elif k == "tank":
            if n.get("recovery") or n.get("small"):
                c.roundRect(x - 28 * s, y - 18 * s, 56 * s, 36 * s, 4 * s, stroke=1, fill=1)
                label(n["label"], x, y + 1 * s, size=9, anchor="center")
                label("回収タンク" if n.get("recovery") else "メンテ用タンク", x, y - 10 * s, size=7, anchor="center")
            else:
                c.setLineWidth(0.6)
                c.roundRect(x - 55 * s, y - 45 * s, 110 * s, 90 * s, 7 * s, stroke=1, fill=1)
                c.setLineWidth(0.35)
                label(n["label"], x, y + 2 * s, size=15, anchor="center")
                label(f'{n.get("capacityKL", 0):,} kL', x, y - 15 * s, size=9, anchor="center")
        elif k in ("source", "sink"):
            w = 70 * s
            x0 = x - 30 * s if k == "source" else x - 10 * s
            poly([(x0, y + 16 * s), (x0 + w - 14 * s, y + 16 * s), (x0 + w, y), (x0 + w - 14 * s, y - 16 * s), (x0, y - 16 * s)])
            label(n["label"], x0 + w / 2 - 6 * s, y - 3 * s, size=9, anchor="center")

    # ── 表題欄 ──
    tb_w, tb_x, tb_y = 250 * mm, PAGE_W - MARGIN - inner - 250 * mm, MARGIN + inner
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(1, 1, 1)
    c.setLineWidth(0.8)
    c.rect(tb_x, tb_y, tb_w, TITLE_H - inner, stroke=1, fill=1)
    c.setLineWidth(0.3)
    rows_tb = [
        ("図名", "仮想空港給油施設　配管系統図（P&ID）"),
        ("図番", "VA-FUEL-P-001　Rev.A"),
        ("縮尺", "NTS（縮尺なし）"),
        ("備考", "配管系統図アプリ下絵機能の試用・デモ用（実在しない施設）"),
    ]
    rh = (TITLE_H - inner) / len(rows_tb)
    for i, (k, v) in enumerate(rows_tb):
        yy = tb_y + (TITLE_H - inner) - rh * (i + 1)
        c.line(tb_x, yy, tb_x + tb_w, yy)
        c.setFillColorRGB(0, 0, 0)
        c.setFont(FONT, 9)
        c.drawString(tb_x + 3 * mm, yy + rh / 2 - 1.2 * mm, k)
        c.setFont(FONT, 13 if i == 0 else 10)
        c.drawString(tb_x + 22 * mm, yy + rh / 2 - 1.6 * mm, v)
    c.line(tb_x + 19 * mm, tb_y, tb_x + 19 * mm, tb_y + TITLE_H - inner)

    # 凡例
    c.setFont(FONT, 8)
    legend = "記号：砂時計形＝仕切弁　三角＋縦線＝逆止弁　円＋三角＝ポンプ（三角は吐出方向）　四角＋×＝ストレーナー　F＝フィルター　小四角＝安全弁・逃し弁　下向き三角＝ドレン口　小円＝圧力計取付口"
    c.drawString(MARGIN + inner + 3 * mm, MARGIN + inner + 3 * mm, legend)

    c.showPage()
    c.save()

    # 下絵の位置合わせ情報：図面（PDF 1ページ全体）を系統図アプリの座標に置くときの左上位置と幅
    align = {
        "file": "virtual-airport-piping.pdf",
        "page": 1,
        "x": -ox / s,
        "y": -top / s,
        "width": PAGE_W / s,
        "height": PAGE_H / s,
    }
    (out / "virtual-airport-piping.json").write_text(json.dumps(align, ensure_ascii=False, indent=1), encoding="utf8")
    print("PDF:", out / "virtual-airport-piping.pdf")
    print("align:", align)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
