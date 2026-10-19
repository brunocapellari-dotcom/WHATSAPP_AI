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
PRICE_UNIT = re.compile(r"/\s*(?:T|TON|TONELADA)\b|POR\s+TONELADA\b", re.IGNORECASE)
PER_LOAD = re.compile(r"\bPOR\s+(?:CARGA|VIAGEM)\b", re.IGNORECASE)
TOLL_INCLUDED = re.compile(r"\bPED(?:AGIO|ÁGIO)?\s+(?:INCLUSO|INCLUIDO|INCLUÍDO)\b", re.IGNORECASE)
TOLL_ADDITIONAL = re.compile(r"(?:\+\s*PED\b|\bPED(?:AGIO|ÁGIO)?\s+(?:A\s+PARTE|SEPARADO))", re.IGNORECASE)
VEHICLE = re.compile(
    r"\b(?:(\d+)\s+)?(RODOTREM|BITREM|CARRETA|VANDERLEIA|LS|9\s*EIXOS)\b",
    re.IGNORECASE,
)
COMMERCIAL_REF = re.compile(
    r"\b(?:OFERTA|REF(?:ERENCIA)?|REFERÊNCIA)\s*[:#-]?\s*([A-Z0-9._/-]+)",
    re.IGNORECASE,
)
STATE_PREFIX = re.compile(r"^\s*(?:-\s*)?(?:MT|MATO GROSSO)\s*[-–—]\s*", re.IGNORECASE)


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
    toll_status: str
    vehicle_type: str | None
    vehicle_count: int | None
    commercial_reference: str | None
    confidence: float
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
    unit: str | None = None
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
        line_unit: str | None
        if PER_LOAD.search(line):
            line_unit = "BRL/carga"
        elif PRICE_UNIT.search(line):
            line_unit = "BRL/t"
        else:
            line_unit = unit
        if PRICE_UNIT.search(line) and PRICE_AFTER_CURRENCY.search(line) is None:
            unit = "BRL/t"
        match = PRICE_AFTER_CURRENCY.search(line)
        if match is None:
            continue
        prefix = line[:match.start()].strip(" \t*📍✅➡️-")
        parsed_place = ORIGIN_AND_LOADING.match(prefix)
        if parsed_place is None:
            continue
        city = parsed_place.group("city").strip(" *📍")
        loading = STATE_PREFIX.sub("", parsed_place.group("loading")).strip(" *")
        # Never parse generic freight commentary or a date as a loading point.
        if not city or not loading or normalize_text(city) in {"FRETE", "DESTINO", "ORIGEM"}:
            continue
        context = f"{line} {text}"
        toll_status = (
            "INCLUDED"
            if TOLL_INCLUDED.search(context)
            else "ADDITIONAL"
            if TOLL_ADDITIONAL.search(context)
            else "UNKNOWN"
        )
        vehicle_match = VEHICLE.search(line)
        reference_match = COMMERCIAL_REF.search(line)
        confidence = min(
            0.95,
            0.60
            + 0.05
            * sum(
                value is not None
                for value in (
                    company,
                    product,
                    city,
                    loading,
                    destination,
                    line_unit,
                )
            ),
        )
        result.append(
            ParsedFreightLine(
                source_observation_id=f"{source_id}:line:{line_no}",
                line_number=line_no,
                company=company,
                product=product,
                origin_city=city,
                loading_point=loading,
                destination_city=destination,
                rate=_rate(match.group(1)),
                rate_unit=line_unit,
                toll_status=toll_status,
                vehicle_type=(
                    normalize_text(vehicle_match.group(2))
                    if vehicle_match
                    else None
                ),
                vehicle_count=(
                    int(vehicle_match.group(1))
                    if vehicle_match and vehicle_match.group(1)
                    else None
                ),
                commercial_reference=(
                    reference_match.group(1) if reference_match else None
                ),
                confidence=confidence,
                evidence_text=line,
            )
        )
    if result:
        return result

    # Common one-offer messages: retain the existing parser's locality fields,
    # but insist on an explicit currency amount before accepting the rate.
    amount = PRICE_AFTER_CURRENCY.search(text)
    if amount is None or not base.origin_raw or not base.destination_raw:
        return []
    toll_status = (
        "INCLUDED"
        if TOLL_INCLUDED.search(text)
        else "ADDITIONAL"
        if TOLL_ADDITIONAL.search(text)
        else "UNKNOWN"
    )
    vehicle_match = VEHICLE.search(text)
    reference_match = COMMERCIAL_REF.search(text)
    confidence = min(
        0.95,
        0.60
        + 0.05
        * sum(
            value is not None
            for value in (
                base.company_raw,
                base.product,
                base.origin_raw,
                base.loading_point_raw,
                base.destination_raw,
                base.rate_unit,
            )
        ),
    )
    return [
        ParsedFreightLine(
            source_observation_id=f"{source_id}:line:1",
            line_number=1,
            company=base.company_raw,
            product=base.product,
            origin_city=base.origin_raw,
            loading_point=base.loading_point_raw,
            destination_city=base.destination_raw,
            rate=_rate(amount.group(1)),
            rate_unit=base.rate_unit,
            toll_status=toll_status,
            vehicle_type=(
                normalize_text(vehicle_match.group(2))
                if vehicle_match
                else None
            ),
            vehicle_count=(
                int(vehicle_match.group(1))
                if vehicle_match and vehicle_match.group(1)
                else None
            ),
            commercial_reference=(
                reference_match.group(1) if reference_match else None
            ),
            confidence=confidence,
            evidence_text=text,
        )
    ]
