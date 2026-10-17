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
    observations, _rejected = observations_from_message(
        source_id="m-2",
        text="SOJA\nDESTINO: RONDONÓPOLIS\nSORRISO - FAZENDA X R$ 180,00 /T",
        published_at=datetime(2026, 10, 16, 7, tzinfo=MT_TIMEZONE),
        resolve_municipality=lambda _: None,
    )
    assert observations == []



def test_adapter_preserves_ibge_codes_and_source_provenance() -> None:
    known = {
        "SORRISO": ("Sorriso", "MT", "5107925"),
        "RONDONÓPOLIS": ("Rondonópolis", "MT", "5107602"),
    }
    observations, rejected = observations_from_message(
        source_id="canonical-1",
        text=(
            "RODOVIVA TRANSPORTES\nSOJA R$/T\n"
            "DESTINO: RONDONÓPOLIS\n"
            "📍 SORRISO - (Fazenda Boa Vista) R$ 180,00 + PED"
        ),
        published_at=datetime(2026, 10, 17, 7, tzinfo=MT_TIMEZONE),
        resolve_municipality=lambda city: known.get(city.upper()),
    )
    assert rejected == []
    assert len(observations) == 1
    item = observations[0]
    assert item.origin_ibge_code == "5107925"
    assert item.destination_ibge_code == "5107602"
    assert item.source_event_id == "canonical-1"
    assert item.source_line_number is not None
    assert item.source_text_sha256 is not None
    assert item.toll_status == "ADDITIONAL"
