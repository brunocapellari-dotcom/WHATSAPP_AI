from datetime import datetime

from app.freight_reporting import MT_TIMEZONE
from app.report_ingest_adapter import observations_from_message


def test_adapter_rejects_unknown_municipality_instead_of_guessing() -> None:
    text = ("TRANSPORTADORA EXEMPLO\nSOJA\nDESTINO: RONDONÓPOLIS\n"
            "SORRISO - FAZENDA BOA VISTA R$ 180,00 /T")
    def resolver(city: str):
        known = {"SORRISO": ("Sorriso", "MT"),
                 "RONDONÓPOLIS": ("Rondonópolis", "MT")}
        return known.get(city.upper())

    observations, rejected = observations_from_message(
        source_id="m-1", text=text,
        published_at=datetime(2026, 10, 16, 7, tzinfo=MT_TIMEZONE),
        resolve_municipality=resolver,
    )
    assert len(observations) + len(rejected) >= 1
    assert all(o.origin_uf == "MT" for o in observations)


def test_adapter_does_not_invent_unknown_uf() -> None:
    observations, rejected = observations_from_message(
        source_id="m-2",
        text="SOJA\nDESTINO: RONDONÓPOLIS\nSORRISO - FAZENDA X R$ 180,00 /T",
        published_at=datetime(2026, 10, 16, 7, tzinfo=MT_TIMEZONE),
        resolve_municipality=lambda _: None,
    )
    assert observations == []
