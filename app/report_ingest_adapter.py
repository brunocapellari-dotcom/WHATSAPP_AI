"""Conservative adapter from multi-offer WhatsApp messages to report observations.

No municipality is invented. The caller supplies an audited canonical
municipality resolver and an explicitly verified origin/destination UF.
Incomplete rows remain excluded rather than silently guessed.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from .freight_multi_parser import parse_freight_lines
from .freight_reporting import FreightObservation

MunicipalityResolver = Callable[[str], tuple[str, str] | None]


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
        if origin is None or destination is None or origin[1].upper() != "MT":
            rejected.append(row.source_observation_id)
            continue
        observations.append(FreightObservation(
            source_observation_id=row.source_observation_id,
            published_at=published_at, received_at=received_at,
            carrier=row.company or "", product=row.product or "",
            origin_city=origin[0], origin_uf=origin[1],
            destination_city=destination[0], destination_uf=destination[1],
            loading_point=row.loading_point or "", rate=row.rate,
            rate_unit=row.rate_unit or "",
        ))
    return observations, rejected
