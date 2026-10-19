from decimal import Decimal

import pytest

from app.freight_multi_parser import parse_freight_lines

MULTI = """FIBRA FORTE TRANSPORTES - FILIAL NOBRES
FRETE DE MILHO — R$/T
Destino: Rondonópolis
📍 São José do Rio Claro - (Faz São Jorge 1) *R$ 160,00*
📍 Nova Maringá - (Faz Vale do Alegre) *R$ 170,00*
📍 Nova Maringá - (Amz Binotti) *R$ 170,00*
📍 Nova Maringá - (Faz Sto Antonio) *R$ 185,00*
"""


def test_four_rows_from_one_carrier_message() -> None:
    lines = parse_freight_lines(MULTI, "msg-1")
    assert len(lines) == 4
    assert len({r.source_observation_id for r in lines}) == 4
    assert {r.company for r in lines} == {"FIBRA FORTE TRANSPORTES - FILIAL NOBRES"}
    assert {r.product for r in lines} == {"MILHO"}
    assert {r.destination_city for r in lines} == {"Rondonópolis"}
    assert [r.rate for r in lines] == [160, 170, 170, 185]
    assert [r.origin_city for r in lines] == [
        "São José do Rio Claro", "Nova Maringá", "Nova Maringá", "Nova Maringá"
    ]
    assert lines[1].loading_point == "Faz Vale do Alegre"
    assert lines[2].loading_point == "Amz Binotti"
    assert all(r.has_required_identity for r in lines)


def test_date_and_phone_are_not_price_amounts() -> None:
    text = ("RODOVIVA TRANSPORTES\nFRETE 13/10/2026\n"
            "Origem: Sorriso\nDestino: Santos\nSOJA\n"
            "Contato (65) 99999-9999")
    assert parse_freight_lines(text, "a") == []


def test_two_destinations_are_not_confused() -> None:
    text = """FIBRA FORTE TRANSPORTES
FRETE DE MILHO — R$/T
Destino: Rondonópolis
📍 Sorriso - (Faz Gaspar) R$ 173,00
Destino: Santos
📍 Sinop - (Faz Boa Vista) R$ 230,00
"""
    results = parse_freight_lines(text, "b")
    assert len(results) == 2
    assert [r.destination_city for r in results] == ["Rondonópolis", "Santos"]


def test_product_change_applies_only_to_subsequent_rows() -> None:
    text = """RODOVIVA TRANSPORTES
Destino: Rondonópolis
FRETE DE SOJA — R$/T
📍 Sorriso - (Faz Gaspar) R$ 173,00
FRETE DE MILHO
📍 Sorriso - (Faz Gaspar) R$ 180,00
"""
    rows = parse_freight_lines(text, "c")
    assert [r.product for r in rows] == ["SOJA", "MILHO"]


def test_missing_carrier_or_unit_is_not_fabricated() -> None:
    rows = parse_freight_lines("DESTINO: Santos\nSOJA\n"
                               "📍 Sinop - (Faz São Jorge) R$ 230,00", "d")
    assert len(rows) == 1
    assert rows[0].company is None
    assert rows[0].rate_unit is None
    assert not rows[0].has_required_identity


def test_thousands_and_decimal_currency_are_parsed() -> None:
    rows = parse_freight_lines("RODOVIVA TRANSPORTES\nSOJA R$/T\n"
        "Destino: Santos\n📍 Sorriso - (Faz A) R$ 1.500,50\n"
        "📍 Sorriso - (Faz B) R$ 1250,00", "e")
    assert [r.rate for r in rows] == [Decimal("1500.50"), Decimal("1250.00")]


def test_single_offer_without_multiple_rows_uses_explicit_currency() -> None:
    text = ("RODOVIVA TRANSPORTES\nORIGEM: SORRISO\n"
            "DESTINO: RONDONOPOLIS\nSOJA\nR$ 175,00/T")
    rows = parse_freight_lines(text, "f")
    assert len(rows) == 1
    assert rows[0].origin_city == "SORRISO"
    assert rows[0].rate == 175
    assert rows[0].loading_point is None


def test_rejects_empty_source_id() -> None:
    with pytest.raises(ValueError):
        parse_freight_lines(MULTI, " ")
