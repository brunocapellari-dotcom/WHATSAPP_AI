from __future__ import annotations

import json
import os
import urllib.request

import psycopg

from app.municipalities import UF_CODES
from app.parser import normalize_text

IBGE_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios"
MAX_RESPONSE_BYTES = 20_000_000


def _extract_uf(item: dict) -> str | None:
    paths = (
        ("microrregiao", "mesorregiao", "UF", "sigla"),
        ("regiao-imediata", "regiao-intermediaria", "UF", "sigla"),
    )
    for path in paths:
        value = item
        for key in path:
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(key)
        if isinstance(value, str) and value in UF_CODES:
            return value
    return None


def _download() -> list[tuple[int, str, str]]:
    request = urllib.request.Request(
        IBGE_URL,
        headers={"User-Agent": "WHATSAPP_AI/municipality-sync"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
        if response.status != 200:
            raise RuntimeError(f"IBGE municipality download returned HTTP {response.status}")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("IBGE municipality response exceeded safety limit")
    payload = json.loads(raw)
    if not isinstance(payload, list) or len(payload) < 5_000:
        raise RuntimeError("IBGE municipality response is incomplete or malformed")

    rows: list[tuple[int, str, str]] = []
    seen: set[int] = set()
    for item in payload:
        if not isinstance(item, dict):
            raise RuntimeError("IBGE municipality row is malformed")
        code = item.get("id")
        name = item.get("nome")
        uf = _extract_uf(item)
        if not isinstance(code, int) or not isinstance(name, str) or not name.strip() or uf is None:
            raise RuntimeError("IBGE municipality row is missing id/name/UF")
        if code in seen:
            raise RuntimeError(f"duplicate IBGE municipality code: {code}")
        seen.add(code)
        rows.append((code, name.strip(), uf))
    return rows


def main() -> int:
    database_url = os.environ.get("DATABASE_URL_MIGRATOR")
    if not database_url:
        raise RuntimeError("DATABASE_URL_MIGRATOR is required")

    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM whatsapp_municipalities")
        current = int(cur.fetchone()[0])
        if current >= 5_000 and os.environ.get("IBGE_FORCE_SYNC", "0") != "1":
            print(f"IBGE_MUNICIPALITY_SYNC_SKIP rows={current}")
            return 0

    rows = _download()
    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        for code, name, uf in rows:
            normalized = normalize_text(name)
            cur.execute(
                """
                INSERT INTO whatsapp_municipalities
                    (ibge_code, official_name, normalized_name, uf, source_url, collected_at)
                VALUES (%s,%s,%s,%s,%s,now())
                ON CONFLICT (ibge_code) DO UPDATE
                SET official_name=EXCLUDED.official_name,
                    normalized_name=EXCLUDED.normalized_name,
                    uf=EXCLUDED.uf,
                    source_url=EXCLUDED.source_url,
                    collected_at=now()
                """,
                (code, name, normalized, uf, IBGE_URL),
            )
            cur.execute(
                """
                INSERT INTO whatsapp_municipality_aliases
                    (alias_normalized, ibge_code, alias_kind)
                VALUES (%s,%s,'OFFICIAL')
                ON CONFLICT (alias_normalized, ibge_code) DO NOTHING
                """,
                (normalized, code),
            )
        cur.execute("SELECT count(*) FROM whatsapp_municipalities")
        total = int(cur.fetchone()[0])
        if total < 5_000:
            raise RuntimeError("canonical municipality table is unexpectedly incomplete")
        conn.commit()

    print(f"IBGE_MUNICIPALITY_SYNC_PASS rows={total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
