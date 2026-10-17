from __future__ import annotations

import re
from dataclasses import dataclass

from .parser import normalize_text

UF_CODES = {
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT",
    "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO",
    "RR", "SC", "SP", "SE", "TO",
}
UF_SUFFIX_RE = re.compile(r"^(.*?)(?:\s*[-/]\s*|\s+)([A-Z]{2})$")


@dataclass(frozen=True)
class MunicipalityQuery:
    normalized_name: str
    explicit_uf: str | None


def municipality_query(raw: str) -> MunicipalityQuery | None:
    value = normalize_text(raw).strip(" -*📍➡️🚀")
    if not value:
        return None
    match = UF_SUFFIX_RE.fullmatch(value)
    if match and match.group(2) in UF_CODES:
        name = match.group(1).strip(" -/")
        if not name:
            return None
        return MunicipalityQuery(name, match.group(2))
    return MunicipalityQuery(value, None)
