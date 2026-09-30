#!/usr/bin/env python3
"""New Eden Exchange — post-event results & statistics PDF."""
from __future__ import annotations

import json
import os
import statistics
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

SLUG = os.environ.get("CHALLENGE_SLUG", "new-eden-exchange")
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://qtp:qtp@localhost:5432/qtp"
)
OUT = Path(
    os.environ.get(
        "OUT",
        Path(__file__).resolve().parents[1]
        / "new-eden-exchange-results-report.pdf",
    )
)

# Quantstorm palette (hex for reportlab)
BG = colors.HexColor("#1E1C1A")
SURFACE = colors.HexColor("#2C2927")
ACCENT = colors.HexColor("#E86A4A")
TEXT = colors.HexColor("#F2EEE8")
MUTED = colors.HexColor("#A8A098")
UP = colors.HexColor("#5CC4A0")
DOWN = colors.HexColor("#E86A6A")
BORDER = colors.HexColor("#4A4642")
WHITE = colors.white


def psql_json(sql: str):
    raw = subprocess.check_output(
        ["psql", DATABASE_URL, "-t", "-A", "-c", sql],
        text=True,
    ).strip()
    return json.loads(raw) if raw else None


def psql_scalar(sql: str):
    return subprocess.check_output(
        ["psql", DATABASE_URL, "-t", "-A", "-c", sql],
        text=True,
    ).strip()


def psql_rows(sql: str) -> list[list[str]]:
    out = subprocess.check_output(
        ["psql", DATABASE_URL, "-t", "-A", "-F", "\t", "-c", sql],
        text=True,
    ).strip()
    if not out:
        return []
    return [line.split("\t") for line in out.split("\n") if line]


def fmt_money(n: float) -> str:
    sign = "+" if n >= 0 else "-"
    return f"{sign}${abs(n):,.2f}"


def fmt_dt(iso: str | None) -> str:
    if not iso:
        return "—"
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return dt.strftime("%d %b %Y, %H:%M UTC")


def load_data() -> dict:
    cid = psql_scalar(f"SELECT id FROM challenges WHERE slug='{SLUG}' LIMIT 1")
    meta = psql_rows(f"""
      SELECT status, starts_at, ends_at, finalized_at,
             (SELECT count(*) FROM challenge_participants WHERE challenge_id='{cid}'),
             config->'edenPostCompensation'
      FROM challenges WHERE id='{cid}';
    """)[0]
    final = sorted(
        json.loads(
            psql_scalar(f"SELECT final_results::text FROM challenges WHERE id='{cid}'")
        ),
        key=lambda r: r["rank"],
    )
    equity_vol = psql_rows(f"""
      SELECT symbol, count(*)::int, sum(quantity)::bigint, sum(quantity*price)::float
      FROM trades WHERE challenge_id='{cid}'
        AND symbol IN ('AERIUM','NEURO','ORBITAL')
      GROUP BY symbol ORDER BY sum(quantity*price) DESC;
    """)
    totals = psql_rows(f"""
      SELECT
        (SELECT count(*) FROM trades WHERE challenge_id='{cid}'),
        (SELECT coalesce(sum(quantity),0) FROM trades WHERE challenge_id='{cid}'),
        (SELECT count(*) FROM loans WHERE challenge_id='{cid}' AND funded_at IS NOT NULL),
        (SELECT coalesce(sum(principal),0) FROM loans WHERE challenge_id='{cid}' AND funded_at IS NOT NULL),
        (SELECT count(*) FROM bond_holdings WHERE challenge_id='{cid}'),
        (SELECT count(*) FROM otc_offers WHERE challenge_id='{cid}'),
        (SELECT count(*) FROM auctions WHERE challenge_id='{cid}');
    """)[0]
    return {
        "cid": cid,
        "status": meta[0],
        "starts_at": meta[1],
        "ends_at": meta[2],
        "finalized_at": meta[3],
        "participants": int(meta[4]),
        "compensation": meta[5] if meta[5] and meta[5] != "null" else None,
        "final": final,
        "equity_vol": equity_vol,
        "trade_count": int(totals[0]),
        "trade_qty": int(totals[1]),
        "loan_count": int(totals[2]),
        "loan_principal": float(totals[3]),
        "bond_holders": int(totals[4]),
        "otc_count": int(totals[5]),
        "auction_count": int(totals[6]),
    }


def build_styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "title",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=28,
            textColor=TEXT,
            spaceAfter=6,
        ),
        "subtitle": ParagraphStyle(
            "subtitle",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=14,
            textColor=ACCENT,
            spaceAfter=14,
        ),
        "h1": ParagraphStyle(
            "h1",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=18,
            textColor=TEXT,
            spaceBefore=16,
            spaceAfter=8,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=13,
            textColor=ACCENT,
            spaceBefore=10,
            spaceAfter=6,
        ),
        "body": ParagraphStyle(
            "body",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            textColor=MUTED,
            leading=14,
        ),
        "bodyLight": ParagraphStyle(
            "bodyLight",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            textColor=TEXT,
            leading=14,
        ),
        "footer": ParagraphStyle(
            "footer",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=8,
            textColor=MUTED,
            alignment=TA_CENTER,
        ),
        "coverBrand": ParagraphStyle(
            "coverBrand",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=11,
            textColor=MUTED,
            letterSpacing=2,
        ),
        "coverHero": ParagraphStyle(
            "coverHero",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=36,
            textColor=TEXT,
            leading=42,
            spaceAfter=12,
        ),
        "coverSub": ParagraphStyle(
            "coverSub",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=16,
            textColor=ACCENT,
            spaceAfter=24,
        ),
    }


def table_style(header_rows: int = 1) -> TableStyle:
    cmds = [
        ("BACKGROUND", (0, 0), (-1, header_rows - 1), SURFACE),
        ("TEXTCOLOR", (0, 0), (-1, -1), TEXT),
        ("FONTNAME", (0, 0), (-1, header_rows - 1), "Helvetica-Bold"),
        ("FONTNAME", (0, header_rows), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, ACCENT),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]
    return TableStyle(cmds)


def zebra_table(table: Table, header_rows: int = 1) -> None:
    style = table_style(header_rows)
    for i in range(header_rows, len(table._cellvalues)):
        if i % 2 == 0:
            style.add("BACKGROUND", (0, i), (-1, i), colors.HexColor("#252322"))
    table.setStyle(style)


def on_page(canvas, doc):
    canvas.saveState()
    w, h = letter
    canvas.setFillColor(BG)
    canvas.rect(0, 0, w, h, fill=1, stroke=0)
    canvas.setFillColor(ACCENT)
    canvas.rect(0, h - 6, w, 6, fill=1, stroke=0)
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(0.65 * inch, 0.55 * inch, w - 0.65 * inch, 0.55 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(
        0.65 * inch, 0.38 * inch, "Quantstorm · New Eden Exchange · Results & Statistics"
    )
    canvas.drawRightString(w - 0.65 * inch, 0.38 * inch, f"Page {doc.page}")
    canvas.restoreState()


def metric_cards(rows: list[tuple[str, str]]) -> Table:
    data = [[Paragraph(f"<b>{k}</b><br/>{v}", ParagraphStyle(
        "m", fontName="Helvetica", fontSize=9, textColor=TEXT, leading=12
    ))] for k, v in rows]
    # 2 columns grid
    grid: list[list] = []
    for i in range(0, len(data), 2):
        left = data[i][0]
        right = data[i + 1][0] if i + 1 < len(data) else ""
        grid.append([left, right])
    t = Table(grid, colWidths=[3.35 * inch, 3.35 * inch], hAlign="LEFT")
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
                ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 10),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ]
        )
    )
    return t


def leaderboard_table(entries: list[dict], limit: int | None = None) -> Table:
    subset = entries[:limit] if limit else entries
    data = [["Rank", "Trader", "Settlement", "Trades", "Volume"]]
    for e in subset:
        m = e.get("metrics") or {}
        name = e.get("displayName") or e.get("username", "?")
        data.append(
            [
                str(e["rank"]),
                name,
                fmt_money(e.get("settlement", e.get("pnl", 0))),
                f"{m.get('trades', 0):,}",
                f"{m.get('volume', 0):,}",
            ]
        )
    t = Table(
        data,
        colWidths=[0.55 * inch, 2.5 * inch, 1.35 * inch, 0.75 * inch, 0.85 * inch],
        repeatRows=1,
    )
    zebra_table(t)
    return t


def main() -> None:
    data = load_data()
    final = data["final"]
    settlements = [e.get("settlement", e.get("pnl", 0)) for e in final]
    total_vol = sum((e.get("metrics") or {}).get("volume", 0) for e in final)
    total_trades_m = sum((e.get("metrics") or {}).get("trades", 0) for e in final)
    busiest = max(final, key=lambda e: (e.get("metrics") or {}).get("trades", 0))

    styles = build_styles()
    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=letter,
        leftMargin=0.65 * inch,
        rightMargin=0.65 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title="New Eden Exchange — Results Report",
        author="Quantstorm",
    )
    story: list = []

    # Cover
    story.append(Spacer(1, 1.1 * inch))
    story.append(Paragraph("QUANTSTORM", styles["coverBrand"]))
    story.append(Spacer(1, 0.15 * inch))
    story.append(HRFlowable(width="30%", thickness=2, color=ACCENT, spaceAfter=20))
    story.append(Paragraph("New Eden Exchange", styles["coverHero"]))
    story.append(Paragraph("Results &amp; Statistics Report", styles["coverSub"]))
    story.append(
        Paragraph(
            f"Event date: {fmt_dt(data['starts_at'])}<br/>"
            f"Status: {data['status'].upper()} · {data['participants']} enrolled · "
            f"{len(final)} ranked",
            styles["bodyLight"],
        )
    )
    story.append(PageBreak())

    # Overview
    story.append(Paragraph("Event overview", styles["h1"]))
    story.append(
        Paragraph(
            "Competitive directional tournament on the New Eden economy: cash equities, "
            "ETF, government bonds, predatory loans, options, Deal Desk OTC, and blind auctions. "
            "Final rankings use mark-to-market settlement scores after the session halt.",
            styles["body"],
        )
    )
    duration_h = ""
    if data["starts_at"] and data["finalized_at"]:
        story.append(Spacer(1, 6))
        story.append(
            Paragraph(
                f"<b>Scheduled end:</b> {fmt_dt(data['ends_at'])}<br/>"
                f"<b>Actual finalize:</b> {fmt_dt(data['finalized_at'])}<br/>"
                f"<b>Scoring:</b> Directional PnL (settlement at close)",
                styles["bodyLight"],
            )
        )
    if data["compensation"]:
        story.append(Spacer(1, 8))
        story.append(Paragraph("Post-event adjustments", styles["h2"]))
        story.append(
            Paragraph(
                "Bond coupons and first-half loan repayments were corrected after an early finalize "
                "(session ended before scheduled <i>endsAt</i>). "
                "Rankings in this report reflect compensated balances recorded in "
                "<i>edenPostCompensation</i>.",
                styles["body"],
            )
        )

    story.append(Spacer(1, 14))
    story.append(
        metric_cards(
            [
                ("Participants", str(data["participants"])),
                ("Ranked traders", str(len(final))),
                ("Exchange fills", f"{data['trade_count']:,}"),
                ("Contracts traded (qty)", f"{data['trade_qty']:,}"),
                ("Loan contracts funded", str(data["loan_count"])),
                ("Total loan principal", fmt_money(data["loan_principal"])),
                ("Bond holders", str(data["bond_holders"])),
                ("OTC offers", str(data["otc_count"])),
                ("Blind auctions", str(data["auction_count"])),
                ("Median settlement", fmt_money(statistics.median(settlements))),
                ("Mean settlement", fmt_money(statistics.mean(settlements))),
                ("Spread (1st − 40th)", fmt_money(settlements[0] - settlements[-1])),
            ]
        )
    )

    story.append(PageBreak())
    story.append(Paragraph("Market activity", styles["h1"]))
    story.append(
        Paragraph(
            "Spot and ETF notional from the trades ledger (excludes option series).",
            styles["body"],
        )
    )
    story.append(Spacer(1, 8))
    mkt = [["Symbol", "Fills", "Volume (qty)", "Notional"]]
    for sym, fills, vol, notional in data["equity_vol"]:
        mkt.append(
            [
                sym,
                f"{int(fills):,}",
                f"{int(float(vol)):,}",
                fmt_money(float(notional)),
            ]
        )
    mt = Table(mkt, colWidths=[1.2 * inch, 0.9 * inch, 1.2 * inch, 1.5 * inch])
    zebra_table(mt)
    story.append(mt)
    story.append(Spacer(1, 12))
    story.append(
        Paragraph(
            f"Aggregate trader metrics (from final snapshots): "
            f"<b>{total_trades_m:,}</b> trades, <b>{total_vol:,}</b> reported volume units.",
            styles["bodyLight"],
        )
    )
    story.append(Spacer(1, 8))
    story.append(Paragraph("Activity highlight", styles["h2"]))
    bm = busiest.get("metrics") or {}
    story.append(
        Paragraph(
            f"Most active by trade count: <b>{busiest.get('displayName') or busiest.get('username')}</b> "
            f"({bm.get('trades', 0):,} trades, {bm.get('volume', 0):,} volume, "
            f"settlement {fmt_money(busiest.get('settlement', 0))}).",
            styles["bodyLight"],
        )
    )

    story.append(PageBreak())
    story.append(Paragraph("Top 10 — Final standings", styles["h1"]))
    story.append(
        Paragraph(
            "Settlement is the official directional score at event end (cash + marked positions + bonds).",
            styles["body"],
        )
    )
    story.append(Spacer(1, 10))
    story.append(leaderboard_table(final, limit=10))

    # Podium callout
    story.append(Spacer(1, 16))
    podium = final[:3]
    pod_txt = " · ".join(
        f"#{e['rank']} {e.get('displayName') or e['username']} ({fmt_money(e.get('settlement', 0))})"
        for e in podium
    )
    story.append(Paragraph(f"<b>Podium:</b> {pod_txt}", styles["bodyLight"]))

    story.append(PageBreak())
    story.append(Paragraph("Full leaderboard", styles["h1"]))
    story.append(leaderboard_table(final))

    story.append(PageBreak())
    story.append(Paragraph("Notes", styles["h1"]))
    story.append(
        Paragraph(
            "• Settlement figures include post-event bond and loan compensation where applicable.<br/>"
            "• One enrolled participant did not appear in final ranked results.<br/>"
            "• Generated from production database snapshots and the persisted "
            "<i>final_results</i> payload.",
            styles["body"],
        )
    )
    story.append(Spacer(1, 20))
    story.append(
        Paragraph(
            f"Report generated {datetime.now(UTC).strftime('%d %b %Y %H:%M UTC')}",
            styles["footer"],
        )
    )

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(OUT.resolve())


if __name__ == "__main__":
    main()
