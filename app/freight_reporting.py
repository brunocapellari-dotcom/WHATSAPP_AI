"""Deterministic freight-report core. No transport side effects or paid services.

A commercial offer belongs to a carrier; a physical cargo can have many offers.
In the absence of a confirmed cargo ID the cargo grouping is *inferred*, not
proof that only one physical load exists. Every report preserves that distinction.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, time
from decimal import Decimal, ROUND_HALF_UP
from collections import Counter
from collections.abc import Iterable
from zoneinfo import ZoneInfo
import hashlib
import json
import unicodedata

MT_TIMEZONE = ZoneInfo("America/Cuiaba")
REPORT_TIMES = {(8, 30), (14, 0), (17, 0)}


def _norm(value: str | None) -> str:
    plain = unicodedata.normalize("NFKD", value or "")
    return " ".join("".join(c for c in plain if not unicodedata.combining(c)).upper().split())


def _identity(*fields: str | None) -> str:
    data = json.dumps([_norm(x) for x in fields], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _local(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must contain timezone information")
    return value.astimezone(MT_TIMEZONE)


def report_slot(published_at: datetime) -> datetime:
    """First scheduled publication where the WhatsApp timestamp can appear.

    Posts from 16:30 through 23:59 are first eligible the NEXT morning.
    The next morning's 00:00-07:59 section remains identifiable separately.
    """
    local = _local(published_at)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    clock = (local.hour, local.minute, local.second, local.microsecond)
    if clock < (8, 0, 0, 0):
        return midnight.replace(hour=8, minute=30)
    if clock < (13, 30, 0, 0):
        return midnight.replace(hour=14)
    if clock < (16, 30, 0, 0):
        return midnight.replace(hour=17)
    return (midnight + timedelta(days=1)).replace(hour=8, minute=30)


def validate_slot(cutoff: datetime) -> datetime:
    local = _local(cutoff)
    if (local.hour, local.minute) not in REPORT_TIMES or local.second or local.microsecond:
        raise ValueError("report publication must be exactly 08:30, 14:00 or 17:00")
    return local


@dataclass(frozen=True)
class FreightObservation:
    source_observation_id: str
    published_at: datetime
    carrier: str
    origin_city: str
    origin_uf: str
    destination_city: str
    destination_uf: str
    product: str
    loading_point: str
    rate: Decimal
    rate_unit: str = "BRL/t"
    offer_reference: str | None = None
    cargo_reference: str | None = None
    shipment_reference: str | None = None
    received_at: datetime | None = None

    def __post_init__(self) -> None:
        _local(self.published_at)
        if self.received_at is not None:
            _local(self.received_at)
        if not self.source_observation_id.strip():
            raise ValueError("source_observation_id is required")
        if not all((self.carrier.strip(), self.origin_city.strip(),
                    self.destination_city.strip(), self.product.strip(),
                    self.loading_point.strip())):
            raise ValueError("carrier, origin, destination, product and loading point are required")
        if not (self.origin_uf.strip() and self.destination_uf.strip()):
            raise ValueError("UF fields are required")
        rate = Decimal(str(self.rate))
        if not rate.is_finite() or rate < 0:
            raise ValueError("rate must be a finite, nonnegative value")
        object.__setattr__(self, "rate", rate)

    @property
    def carrier_key(self) -> str:
        return _identity(self.carrier, self.origin_city, self.origin_uf,
                         self.destination_city, self.destination_uf, self.loading_point,
                         self.product, self.rate_unit, self.shipment_reference,
                         self.offer_reference)

    @property
    def cargo_key(self) -> str:
        if self.cargo_reference:
            return _identity("CONFIRMED", self.cargo_reference, self.product,
                             self.origin_city, self.origin_uf,
                             self.destination_city, self.destination_uf,
                             self.shipment_reference)
        return _identity("INFERRED", self.origin_city, self.origin_uf,
                         self.loading_point, self.destination_city,
                         self.destination_uf, self.product, self.shipment_reference)

    @property
    def cargo_confirmed(self) -> bool:
        return bool(self.cargo_reference)


@dataclass(frozen=True)
class PriceMovement:
    carrier: str
    origin: str
    destination: str
    product: str
    loading_point: str
    before: Decimal
    after: Decimal
    delta: Decimal
    percent: Decimal | None
    changed_at: datetime


@dataclass
class _OfferState:
    offer: FreightObservation
    first_seen: datetime
    last_seen: datetime
    absences: int = 0


@dataclass(frozen=True)
class FullReport:
    cutoff: datetime
    active_offers: tuple[FreightObservation, ...]
    movements: tuple[PriceMovement, ...]
    new_offers: int
    reconfirmed_offers: int
    expired_offers: int
    duplicate_source_events: int
    observed_in_window: int
    collector_healthy: bool

    @property
    def by_city_and_carrier(self) -> dict[tuple[str, str], int]:
        counts: Counter[tuple[str, str]] = Counter()
        for o in self.active_offers:
            counts[(o.origin_city, o.carrier)] += 1
        return dict(sorted(counts.items()))

    @property
    def increases(self) -> int:
        return sum(m.delta > 0 for m in self.movements)

    @property
    def decreases(self) -> int:
        return sum(m.delta < 0 for m in self.movements)


@dataclass(frozen=True)
class SimplifiedRow:
    origin_city: str
    origin_uf: str
    loading_point: str
    destination_city: str
    destination_uf: str
    product: str
    rate_unit: str
    lowest_rate: Decimal
    highest_rate: Decimal
    cargo_confirmed: bool
    commercial_offers: int

    @property
    def rate_display(self) -> str:
        suffix = "/t" if self.rate_unit == "BRL/t" else "/carga" if self.rate_unit == "BRL/carga" else " (" + self.rate_unit + ")"
        def formatted(value: Decimal) -> str:
            return f"{value:,.2f}".replace(",", "@").replace(".", ",").replace("@", ".")
        if self.lowest_rate == self.highest_rate:
            return f"R$ {formatted(self.lowest_rate)}{suffix}"
        return f"R$ {formatted(self.lowest_rate)}–{formatted(self.highest_rate)}{suffix}"


@dataclass(frozen=True)
class SimplifiedReport:
    cutoff: datetime
    rows: tuple[SimplifiedRow, ...]
    origin_totals: dict[str, int]
    destination_totals: dict[str, int]

    @property
    def total_open_lots(self) -> int:
        return len(self.rows)


def simplify(full: FullReport) -> SimplifiedReport:
    """One inferred/confirmed MT-origin cargo per row, never one per carrier."""
    grouped: dict[tuple[str, str], list[FreightObservation]] = {}
    for offer in full.active_offers:
        if _norm(offer.origin_uf) != "MT":
            continue
        grouped.setdefault((offer.cargo_key, _norm(offer.rate_unit)), []).append(offer)

    rows: list[SimplifiedRow] = []
    for offers in grouped.values():
        first = offers[0]
        prices = [o.rate for o in offers]
        rows.append(SimplifiedRow(
            origin_city=first.origin_city, origin_uf=first.origin_uf,
            loading_point=first.loading_point, destination_city=first.destination_city,
            destination_uf=first.destination_uf, product=first.product,
            rate_unit=first.rate_unit, lowest_rate=min(prices),
            highest_rate=max(prices), cargo_confirmed=first.cargo_confirmed,
            commercial_offers=len(offers),
        ))
    rows.sort(key=lambda x: (_norm(x.origin_city), _norm(x.loading_point),
                             _norm(x.destination_city), _norm(x.product), _norm(x.rate_unit)))

    origin: Counter[str] = Counter()
    dest: Counter[str] = Counter()
    for row in rows:
        origin[row.origin_city] += 1
        dest[f"{row.destination_city}/{row.destination_uf.upper()}"] += 1
    return SimplifiedReport(full.cutoff, tuple(rows), dict(sorted(origin.items())),
                            dict(sorted(dest.items())))


def render_simplified_markdown(report: SimplifiedReport) -> str:
    """Two main columns; lot totals only at the END of the report."""
    result = [
        "# RELATÓRIO SIMPLIFICADO DE FRETES",
        f"Horário de referência: {report.cutoff:%d/%m/%Y %H:%M} (MT)",
        "Origens: exclusivamente municípios de Mato Grosso.",
        "",
        "| Origem → Destino | Frete |",
        "|---|---:|",
    ]
    for row in report.rows:
        left = (f"{row.origin_city}/MT (Faz./Armazém {row.loading_point}) → "
                f"{row.destination_city}/{row.destination_uf.upper()} — {row.product}")
        result.append(f"| {left} | {row.rate_display} |")
    result.extend((
        "",
        f"**Total de lotes abertos: {report.total_open_lots}**",
        "",
        "## Totalizador por município de origem",
        "| Município (MT) | Lotes |", "|---|---:|",
    ))
    result.extend(f"| {city} | {total} |" for city, total in report.origin_totals.items())
    result.extend((f"| **Total** | **{sum(report.origin_totals.values())}** |", "",
                   "## Totalizador por município de destino",
                   "| Destino | Lotes |", "|---|---:|"))
    result.extend(f"| {city} | {total} |" for city, total in report.destination_totals.items())
    result.extend((f"| **Total** | **{sum(report.destination_totals.values())}** |", "",
                   "_Quando não houver identificador inequívoco, a identidade do lote é "
                   "inferida por local de carregamento, rota, produto e período de embarque._"))
    return "\n".join(result) + "\n"


def render_full_markdown(report: FullReport) -> str:
    result = [
        "# RELATÓRIO COMPLETO DE FRETES",
        f"Horário: {report.cutoff:%d/%m/%Y %H:%M} (MT)",
        f"Ofertas comerciais ativas: {len(report.active_offers)}",
        f"Novas: {report.new_offers} | Reconfirmadas: {report.reconfirmed_offers} "
        f"| Aumentos: {report.increases} | Reduções: {report.decreases} "
        f"| Retiradas após 3 ausências: {report.expired_offers}",
        "",
        "| Origem / Carregamento | Destino | Produto | Transportadora | Frete |",
        "|---|---|---|---|---:|",
    ]
    for o in report.active_offers:
        result.append(f"| {o.origin_city}/{o.origin_uf} ({o.loading_point}) "
                      f"| {o.destination_city}/{o.destination_uf} | {o.product} "
                      f"| {o.carrier} | {o.rate} {o.rate_unit} |")
    result.extend(("", "## Reajustes no intervalo", 
                   "| Transportadora | Origem → Destino | Anterior | Atual | Δ R$ | Δ % |",
                   "|---|---|---:|---:|---:|---:|"))
    for m in report.movements:
        result.append(f"| {m.carrier} | {m.origin} → {m.destination} | {m.before} "
                      f"| {m.after} | {m.delta:+} | "
                      f"{str(m.percent) + '%' if m.percent is not None else 'N/D'} |")
    result.extend(("", "## Ofertas por município de origem e transportadora",
                   "| Município | Transportadora | Ofertas |", "|---|---|---:|"))
    for (city, carrier), total in report.by_city_and_carrier.items():
        result.append(f"| {city} | {carrier} | {total} |")
    result.append("")
    return "\n".join(result)


class FreightReportEngine:
    """Replayable calculation engine; caller persists snapshots and observations.

    Each call represents ONE scheduled closure. A healthy closure with no
    reconfirmation increments absence once. An unhealthy one freezes absences.
    """
    def __init__(self) -> None:
        self._offers: dict[str, _OfferState] = {}
        self._observations: set[str] = set()
        self._last_cutoff: datetime | None = None

    def process(self, cutoff: datetime, observations: Iterable[FreightObservation],
                *, collector_healthy: bool = True) -> FullReport:
        cutoff = validate_slot(cutoff)
        if self._last_cutoff is not None and cutoff <= self._last_cutoff:
            raise ValueError("cutoffs must be processed in ascending order")

        movements: list[PriceMovement] = []
        observed_keys: set[str] = set()
        new: set[str] = set()
        reconfirmed: set[str] = set()
        duplicates = 0
        observed = 0
        items = sorted(observations, key=lambda o: (_local(o.published_at), o.source_observation_id))
        for o in items:
            if o.source_observation_id in self._observations:
                duplicates += 1
                continue
            # Do not use messages received after the published report, or messages
            # whose assigned first report has not yet been reached.
            if report_slot(o.published_at) > cutoff or (o.received_at and _local(o.received_at) > cutoff):
                continue
            self._observations.add(o.source_observation_id)
            if report_slot(o.published_at) == cutoff:
                observed += 1
            key = o.carrier_key
            prior = self._offers.get(key)
            if prior is None:
                self._offers[key] = _OfferState(o, _local(o.published_at), _local(o.published_at))
                new.add(key)
            elif _local(o.published_at) >= prior.last_seen:
                if prior.offer.rate != o.rate and prior.offer.rate_unit == o.rate_unit:
                    delta = o.rate - prior.offer.rate
                    pct = (delta / prior.offer.rate * 100).quantize(
                        Decimal("0.01"), rounding=ROUND_HALF_UP) if prior.offer.rate else None
                    movements.append(PriceMovement(o.carrier, o.origin_city, o.destination_city,
                        o.product, o.loading_point, prior.offer.rate, o.rate, delta, pct,
                        _local(o.published_at)))
                prior.offer = o
                prior.last_seen = _local(o.published_at)
                prior.absences = 0
                reconfirmed.add(key)
            if report_slot(o.published_at) == cutoff:
                observed_keys.add(key)
        expired = 0
        for key, state in list(self._offers.items()):
            if key in observed_keys or key in new:
                state.absences = 0
            elif collector_healthy:
                state.absences += 1
                if state.absences >= 3:
                    del self._offers[key]
                    expired += 1
        self._last_cutoff = cutoff
        active = tuple(s.offer for _, s in sorted(
            self._offers.items(), key=lambda x: (_norm(x[1].offer.origin_city),
                _norm(x[1].offer.carrier), _norm(x[1].offer.destination_city), x[0])))
        return FullReport(cutoff, active, tuple(movements), len(new),
                          len(reconfirmed - new), expired, duplicates,
                          observed, collector_healthy)
