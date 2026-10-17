"""Regression tests for currency parsing; audit F-06 and F-25."""
from decimal import Decimal

from app.parser import parse_freight


def test_nine_axles_is_not_the_price():
    result = parse_freight("SOJA\nOrigem: Sorriso\nDestino: Rondonópolis\nFrete 9 eixos R$ 180,00/t")
    assert result.rate == Decimal("180.00")
    assert result.rate_unit == "BRL/t"


def test_date_is_not_the_price():
    result = parse_freight("SOJA\nOrigem: Sorriso\nDestino: Rondonópolis\n15/10 frete R$ 180/t")
    assert result.rate == Decimal(180)
    assert result.rate_unit == "BRL/t"


def test_mato_grosso_abbreviation_is_not_tonnage():
    result = parse_freight("SOJA\nOrigem: Sorriso MT\nDestino: Rondonópolis\nR$ 9.000 por carga")
    assert result.rate == Decimal(9000)
    assert result.rate_unit == "BRL/carga"


def test_dot_decimal_not_truncated():
    result = parse_freight("SOJA\nOrigem: Sorriso\nDestino: Rondonópolis\nR$ 180.50/t")
    assert result.rate == Decimal("180.50")
    assert result.rate_unit == "BRL/t"


def test_unknown_unit_is_not_inferred_from_state():
    result = parse_freight("SOJA\nOrigem: Sinop/MT\nDestino: Rondonópolis\nR$ 180")
    assert result.rate == Decimal(180)
    assert result.rate_unit is None
