"""Side-effect-free report exports with spreadsheet formula-injection protection.

Exports accept already-validated report snapshots. No network or WhatsApp access.
"""
from __future__ import annotations

from io import BytesIO

from .freight_reporting import (
    FullReport,
    SimplifiedReport,
    render_full_markdown,
    render_simplified_markdown,
)


def safe_spreadsheet_text(value: object) -> str:
    """Neutralize cells that spreadsheet applications could execute as formulas."""
    text = str(value).replace("\x00", "").replace("\r", " ").replace("\n", " ")
    if text.startswith("\t") or text.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


def simplified_xlsx(report: SimplifiedReport) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Fretes"
    ws.append(["Origem / Destino", "Frete"])
    for row in report.rows:
        route = f"{row.origin_city}/MT ({row.loading_point}) → {row.destination_city}/{row.destination_uf}"
        ws.append([safe_spreadsheet_text(route), safe_spreadsheet_text(row.rate_display)])
    ws.append([])
    ws.append(["Total de lotes abertos", report.total_open_lots])
    ws.append([])
    ws.append(["Município de origem (MT)", "Lotes"])
    for city, count in report.origin_totals.items():
        ws.append([safe_spreadsheet_text(city), count])
    ws.append([])
    ws.append(["Município de destino", "Lotes"])
    for city, count in report.destination_totals.items():
        ws.append([safe_spreadsheet_text(city), count])
    ws.freeze_panes = "A2"
    ws.column_dimensions["A"].width = 70
    ws.column_dimensions["B"].width = 30
    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def full_xlsx(report: FullReport) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Ofertas"
    ws.append(["Origem", "UF origem", "Carregamento", "Destino", "UF destino",
               "Produto", "Transportadora", "Frete", "Unidade"])
    for o in report.active_offers:
        ws.append([safe_spreadsheet_text(x) for x in (
            o.origin_city, o.origin_uf, o.loading_point, o.destination_city,
            o.destination_uf, o.product, o.carrier,
        )] + [float(o.rate), safe_spreadsheet_text(o.rate_unit)])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def report_pdf(report: FullReport | SimplifiedReport) -> bytes:
    """Create a PDF from a validated report without executing any embedded markup."""
    from html import escape

    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    markdown = (render_full_markdown(report) if isinstance(report, FullReport)
                else render_simplified_markdown(report))
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=(595, 842), leftMargin=36,
                            rightMargin=36, topMargin=36, bottomMargin=36)
    styles = getSampleStyleSheet()
    story = []
    for line in markdown.splitlines():
        if not line.strip():
            story.append(Spacer(1, 6))
            continue
        # Treat Markdown as literal text. Never interpret user-supplied HTML.
        style = styles["Heading2"] if line.startswith("#") else styles["Normal"]
        text = line.lstrip("# ").strip()
        story.append(Paragraph(escape(text), style))
    doc.build(story)
    return buffer.getvalue()
