"""Conservative one-message-to-many-freight-lines extraction.

This parser supplements (does not silently replace) the existing single-offer
pipeline. Unknown municipality, unit or loading point remains unknown until a
separate entity resolver validates it; no UF or ANTT distance is invented.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal

from .parser import PRODUCT_ALIASES, normalize_text, parse_freight

PRICE_AFTER_CURRENCY = re.compile(
    r"R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d.,])"
)
DESTINATION = re.compile(r"\bDESTINO\s*:\s*(.+)", re.IGNORECASE)
ORIGIN_AND_LOADING = re.compile(
    r"^\s*(?P<city>[^—–-]+?)\s*[—–-]\s*"
    r"\(?(?P<loading>[^()]+)\)?\s*$"
)
PRICE_UNIT = re.compile(r"(?:R\$\s*[\d.,]+\s*)?/\s*(?:T|TON|TONELADA)\b", re.IGNORECASE)


@dataclass(frozen=True)
class ParsedFreightLine:
    source_observation_id: str
    line_number: int
    company: str | None
    product: str | None
    origin_city: str | None
    loading_point: str | None
    destination_city: str | None
    rate: Decimal
    rate_unit: str | None
    evidence_text: str

    @property
    def has_required_identity(self) -> bool:
        return bool(self.company and self.product and self.origin_city
                    and self.destination_city and self.loading_point and self.rate_unit)


def _rate(value: str) -> Decimal:
    # Locale-aware parsing; comma decimals and dotted thousand separators.
    if "," in value:
        value = value.replace(".", "").replace(",", ".")
    elif value.count(".") == 1 and len(value.split(".")[-1]) == 3:
        value = value.replace(".", "")
    return Decimal(value)


def _detect_product(line: str) -> str | None:
    n = normalize_text(line)
    for alias, canonical in sorted(PRODUCT_ALIASES.items(), key=lambda x: -len(x[0])):
        if re.search(r"\b" + re.escape(normalize_text(alias)) + r"\b", n):
            return canonical
    return None


def parse_freight_lines(text: str, source_id: str) -> list[ParsedFreightLine]:
    """Extract multiple farm/municipality rows sharing a carrier/destination header.

    Only explicit R$ prices are accepted. This prevents dates and phone numbers
    from becoming freight rates. The caller must resolve municipality/UF and
    decide how to handle incomplete rows.
    """
    if not source_id.strip():
        raise ValueError("source_id is required")
    base = parse_freight(text)
    product = base.product
    company = base.company_raw
    destination = base.destination_raw
    unit = base.rate_unit
    result: list[ParsedFreightLine] = []
    for line_no, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        dst_match = DESTINATION.search(line)
        if dst_match:
            destination = dst_match.group(1).strip(" *:-🎯➡️")
        new_product = _detect_product(line)
        if new_product:
            product = new_product
        if PRICE_UNIT.search(line):
            unit = "BRL/t"
        match = PRICE_AFTER_CURRENCY.search(line)
        if match is None:
            continue
        prefix = line[:match.start()].strip(" \t*📍✅➡️-")
        parsed_place = ORIGIN_AND_LOADING.match(prefix)
        if parsed_place is None:
            continue
        city = parsed_place.group("city").strip(" *📍")
        loading = parsed_place.group("loading").strip(" *")
        # Never parse generic freight commentary or a date as a loading point.
        if not city or not loading or normalize_text(city) in {"FRETE", "DESTINO", "ORIGEM"}:
            continue
        result.append(ParsedFreightLine(
            source_observation_id=f"{source_id}:line:{line_no}",
            line_number=line_no,
            company=company, product=product, origin_city=city,
            loading_point=loading, destination_city=destination,
            rate=_rate(match.group(1)), rate_unit=unit,
            evidence_text=line,
        ))
    if result:
        return result

    # Common one-offer messages: retain the existing parser's locality fields,
    # but insist on an explicit currency amount before accepting the rate.
    amount = PRICE_AFTER_CURRENCY.search(text)
    if amount is None or not base.origin_raw or not base.destination_raw:
        return []
    return [ParsedFreightLine(
        source_observation_id=f"{source_id}:line:1", line_number=1,
        company=base.company_raw, product=base.product,
        origin_city=base.origin_raw, loading_point=base.loading_point_raw,
        destination_city=base.destination_raw, rate=_rate(amount.group(1)),
        rate_unit=base.rate_unit, evidence_text=text,
    )]
