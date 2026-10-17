"""Conservative adapter from multi-offer WhatsApp messages to report observations.

No municipality is invented. The caller supplies an audited canonical
municipality resolver and an explicitly verified origin/destination UF.
Incomplete rows remain excluded rather than silently guessed.
"""
from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import datetime

from .freight_multi_parser import parse_freight_lines
from .freight_reporting import FreightObservation

MunicipalityResolver = Callable[
    [str],
    tuple[str, str] | tuple[str, str, str] | None,
]


def _resolved_parts(
    value: tuple[str, str] | tuple[str, str, str],
) -> tuple[str, str, str | None]:
    if len(value) == 2:
        return value[0], value[1], None
    return value[0], value[1], value[2]


def observations_from_message(
    *,
    source_id: str,
    text: str,
    published_at: datetime,
    resolve_municipality: MunicipalityResolver,
    received_at: datetime | None = None,
) -> tuple[list[FreightObservation], list[str]]:
    observations: list[FreightObservation] = []
    rejected: list[str] = []
    for row in parse_freight_lines(text, source_id):
        if not row.has_required_identity:
            rejected.append(row.source_observation_id)
            continue
        origin = resolve_municipality(row.origin_city or "")
        destination = resolve_municipality(row.destination_city or "")
        if origin is None or destination is None:
            rejected.append(row.source_observation_id)
            continue
        origin_city, origin_uf, origin_code = _resolved_parts(origin)
        destination_city, destination_uf, destination_code = _resolved_parts(
            destination
        )
        if origin_uf.upper() != "MT":
            rejected.append(row.source_observation_id)
            continue
        evidence_hash = hashlib.sha256(row.evidence_text.encode("utf-8")).hexdigest()
        observations.append(
            FreightObservation(
                source_observation_id=row.source_observation_id,
                source_event_id=source_id,
                source_line_number=row.line_number,
                published_at=published_at,
                received_at=received_at,
                carrier=row.company or "",
                product=row.product or "",
                origin_city=origin_city,
                origin_uf=origin_uf,
                origin_ibge_code=origin_code,
                destination_city=destination_city,
                destination_uf=destination_uf,
                destination_ibge_code=destination_code,
                loading_point=row.loading_point or "",
                rate=row.rate,
                rate_unit=row.rate_unit or "",
                source_text_sha256=evidence_hash,
                extraction_confidence=row.confidence,
                toll_status=row.toll_status,
                vehicle_type=row.vehicle_type,
                vehicle_count=row.vehicle_count,
                offer_reference=row.commercial_reference,
            )
        )
    return observations, rejected
