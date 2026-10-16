"""Report export regressions: bytes, totals and untrusted spreadsheet input."""
from io import BytesIO

from openpyxl import load_workbook

from app.freight_reporting import FreightReportEngine, simplify
from app.report_exports import (
    full_xlsx,
    report_pdf,
    safe_spreadsheet_text,
    simplified_xlsx,
)
from tests.test_freight_reporting import dt, offer


def test_formula_injection_is_neutralized() -> None:
    for prefix in ("=", "+", "-", "@", "\t"):
        assert safe_spreadsheet_text(prefix + "SUM(1,1)").startswith("'")
    assert safe_spreadsheet_text("Safe") == "Safe"


def test_simplified_export_has_two_main_columns_and_totals() -> None:
    engine = FreightReportEngine()
    full = engine.process(dt(15, 8, 30), [
        offer("export-a", carrier="A", loading_point="=HYPERLINK(1)"),
        offer("export-b", carrier="B", loading_point="=HYPERLINK(1)"),
    ])
    simple = simplify(full)
    wb = load_workbook(BytesIO(simplified_xlsx(simple)), read_only=True)
    ws = wb.active
    assert [ws["A1"].value, ws["B1"].value] == ["Origem / Destino", "Frete"]
    assert ws["A2"].value.startswith("'")
    assert any(row[0] == "Total de lotes abertos" and row[1] == 1
               for row in ws.values)


def test_full_export_and_pdf_have_valid_file_signatures() -> None:
    engine = FreightReportEngine()
    full = engine.process(dt(15, 8, 30), [offer("export-1")])
    assert full_xlsx(full).startswith(b"PK")
    assert simplified_xlsx(simplify(full)).startswith(b"PK")
    assert report_pdf(full).startswith(b"%PDF")
    assert report_pdf(simplify(full)).startswith(b"%PDF")
