from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from .models import EntityValue, FreightClassification

RATE_RE = re.compile(r"(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}(?!\d)")
DATE_RE = re.compile(r"\b(\d{1,2}/\d{1,2}(?:/\d{2,4})?)\b")
URL_RE = re.compile(r"https?://[^\s]+", re.IGNORECASE)
TON_RE = re.compile(r"\b(\d+(?:[.,]\d+)?)\s*(?:t|ton|tons|toneladas?)\b", re.IGNORECASE)
VACANCY_RE = re.compile(r"\b(\d+)\s*(?:vagas?|cargas?|caminh[oõ]es?)\b", re.IGNORECASE)

PRODUCT_ALIASES = {
    "SOJA": "SOJA",
    "SOY": "SOJA",
    "MILHO": "MILHO",
    "CORN": "MILHO",
    "FARELO": "FARELO_DE_SOJA",
    "FARELO DE SOJA": "FARELO_DE_SOJA",
    "ALGODAO": "ALGODAO",
    "ALGODÃO": "ALGODAO",
    "FERTILIZANTE": "FERTILIZANTES",
    "FERTILIZANTES": "FERTILIZANTES",
}


def _plain(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in value if not unicodedata.combining(ch))


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", _plain(value).upper()).strip()


def classify_message(text: str) -> FreightClassification:
    n = normalize_text(text)
    if not n:
        return FreightClassification.UNKNOWN
    if any(token in n for token in ("CANCELADO", "CANCELADA", "CANCELAR", "SEM CARGA", "ENCERRADO")):
        return FreightClassification.CANCELLATION
    if any(token in n for token in ("ATUALIZACAO", "ATUALIZAÇÃO", "REAJUSTE", "NOVO VALOR", "ALTERADO")):
        return FreightClassification.UPDATE
    freight_signal = any(token in n for token in ("FRETE", "CARGA", "EMBARQUE", "ORIGEM", "DESTINO", "R$", "ROTA"))
    request_signal = any(token in n for token in ("PRECISO", "PROCURA", "BUSCO", "TEM CAMINHAO", "TEM CAMINHÃO"))
    if freight_signal and request_signal:
        return FreightClassification.FREIGHT_REQUEST
    if freight_signal and any(product in n for product in PRODUCT_ALIASES):
        return FreightClassification.FREIGHT_OFFER
    if freight_signal:
        return FreightClassification.INFORMATION
    return FreightClassification.IRRELEVANT


def _value_after_markers(lines: list[str], markers: Iterable[str]) -> str | None:
    for line in lines:
        normalized = normalize_text(line)
        for marker in markers:
            marker_n = normalize_text(marker)
            if marker_n in normalized:
                split = re.split(re.escape(marker), line, flags=re.IGNORECASE, maxsplit=1)
                if len(split) == 2 and split[1].strip(" :-➡️🚀📍"):
                    return split[1].strip(" :-➡️🚀📍")
    return None


def _emoji_locations(lines: list[str]) -> tuple[str | None, str | None]:
    pins = [line.replace("📍", "").strip() for line in lines if "📍" in line and line.replace("📍", "").strip()]
    rockets = [line.replace("🚀", "").replace("➡️", "").strip() for line in lines if ("🚀" in line or "➡️" in line) and line.replace("🚀", "").replace("➡️", "").strip()]
    return (pins[0] if pins else None, rockets[0] if rockets else None)


def _loading_point(lines: list[str], product: str | None) -> str | None:
    explicit = _value_after_markers(
        lines,
        (
            "LOCAL DE EMBARQUE:",
            "PONTO DE EMBARQUE:",
            "EMBARQUE EM:",
        ),
    )
    if explicit:
        return explicit

    if product is None:
        return None
    product_n = normalize_text(product.replace("_", " "))
    for line in lines:
        n = normalize_text(line)
        if product_n not in n:
            continue
        if any(token in n for token in ("TRANSPORT", "LOGIST", "CARGAS DISPONIVEIS")):
            continue
        cleaned = re.sub(r"^[^\wÀ-ÿ]+", "", line).strip("* ")
        parts = re.split(r"\s+[—–-]\s+", cleaned, maxsplit=1)
        if len(parts) != 2:
            continue
        candidate = parts[0].strip("* ✅📍")
        candidate_n = normalize_text(candidate)
        if candidate_n and candidate_n not in {"FRETE", product_n}:
            return candidate
    return None


@dataclass(frozen=True)
class ParsedFreight:
    classification: FreightClassification
    product: str | None
    origin_raw: str | None
    destination_raw: str | None
    loading_point_raw: str | None
    company_raw: str | None
    rate: Decimal | None
    rate_unit: str | None
    phone: str | None
    date_text: str | None
    tonnage: Decimal | None
    vacancies: int | None
    links: list[str]
    confidence: float


def parse_freight(text: str) -> ParsedFreight:
    classification = classify_message(text)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    normalized = normalize_text(text)

    product = None
    for alias, canonical in sorted(PRODUCT_ALIASES.items(), key=lambda item: -len(item[0])):
        if normalize_text(alias) in normalized:
            product = canonical
            break

    origin = _value_after_markers(lines, ("ORIGEM:", "ORIGEM", "SAÍDA:", "SAIDA:"))
    destination = _value_after_markers(lines, ("DESTINO:", "DESTINO", "ENTREGA:"))
    emoji_origin, emoji_destination = _emoji_locations(lines)
    origin = origin or emoji_origin
    destination = destination or emoji_destination

    loading_point = _loading_point(lines, product)

    company = None
    for line in lines[:4]:
        n = normalize_text(line)
        if (
            any(token in n for token in ("TRANSPORT", "LOGIST", "CARGILL", "BUNGE", "ADM", "COFCO"))
            or n == "RODOVIVA"
            or n.startswith("RODOVIVA ")
        ):
            company = line.strip("* ")
            break

    if (
        loading_point
        and company
        and normalize_text(loading_point) == normalize_text(company)
    ):
        loading_point = None

    rate = None
    for line in lines:
        if "R$" in line.upper() or "FRETE" in normalize_text(line):
            match = RATE_RE.search(line)
            if match:
                raw = match.group(1).replace(".", "").replace(",", ".")
                rate = Decimal(raw)
                break

    rate_unit = None
    if rate is not None:
        if re.search(r"(?:R\$\s*)?/?\s*(?:T|TON|TONELADA)\b", normalized, re.IGNORECASE):
            rate_unit = "BRL/t"
        elif re.search(r"POR\s+(?:VIAGEM|CARGA)\b", normalized):
            rate_unit = "BRL/carga"

    phone_m = PHONE_RE.search(text)
    date_m = DATE_RE.search(text)
    ton_m = TON_RE.search(text)
    vacancy_m = VACANCY_RE.search(text)
    links = URL_RE.findall(text)

    required = [product, origin, destination]
    confidence = 0.35 + 0.15 * sum(item is not None for item in required)
    if rate is not None:
        confidence += 0.10
    if company:
        confidence += 0.05
    confidence = min(confidence, 0.95)

    return ParsedFreight(
        classification=classification,
        product=product,
        origin_raw=origin,
        destination_raw=destination,
        loading_point_raw=loading_point,
        company_raw=company,
        rate=rate,
        rate_unit=rate_unit,
        phone=phone_m.group(0) if phone_m else None,
        date_text=date_m.group(1) if date_m else None,
        tonnage=Decimal(ton_m.group(1).replace(",", ".")) if ton_m else None,
        vacancies=int(vacancy_m.group(1)) if vacancy_m else None,
        links=links,
        confidence=confidence,
    )


class EntityResolver:
    def __init__(self, aliases: dict[str, dict[str, str]] | None = None) -> None:
        self.aliases = aliases or {}

    def resolve(self, kind: str, raw: str | None) -> EntityValue | None:
        if raw is None:
            return None
        normalized = normalize_text(raw)
        canonical_id = self.aliases.get(kind, {}).get(normalized)
        return EntityValue(
            raw_value=raw,
            normalized_value=normalized,
            canonical_id=canonical_id,
            confidence=1.0 if canonical_id else 0.70,
        )
