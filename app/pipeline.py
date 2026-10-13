from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from uuid import uuid4

from .models import (
    FreightClassification,
    FreightEvent,
    IngestionResult,
    RawInboundEvent,
    RateChange,
    RateMovement,
    TruthClassification,
)
from .parser import EntityResolver, ParsedFreight, normalize_text, parse_freight
from .storage import FreightStore


def _logical_key(parts: list[str | None]) -> str:
    normalized = "|".join(normalize_text(part or "") for part in parts)
    return hashlib.sha256(normalized.encode()).hexdigest()


def _semantic_signature(event: FreightEvent) -> str:
    payload = {
        "classification": event.classification,
        "product": event.product,
        "origin": event.origin.normalized_value if event.origin else None,
        "destination": event.destination.normalized_value if event.destination else None,
        "entities": event.entities,
        "rate": str(event.rate) if event.rate is not None else None,
        "rate_unit": event.rate_unit,
        "metadata": {
            "date_text": event.metadata.get("date_text"),
            "tonnage": event.metadata.get("tonnage"),
            "vacancies": event.metadata.get("vacancies"),
        },
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def _company(event: FreightEvent):
    values = event.entities.get("company", [])
    return values[0] if values else None


def _incoming_actor(company, raw: RawInboundEvent) -> str:
    if company and company.normalized_value:
        return f"COMPANY:{company.normalized_value}"
    for field in ("author", "from", "notify_name"):
        value = raw.metadata.get(field)
        if isinstance(value, str) and value.strip():
            return f"SENDER:{normalize_text(value)}"
    return f"SOURCE:{normalize_text(raw.source)}"


def _event_actor(event: FreightEvent) -> str:
    company = _company(event)
    if company and company.normalized_value:
        return f"COMPANY:{company.normalized_value}"
    value = event.metadata.get("actor_identity")
    if isinstance(value, str) and value:
        return value
    return f"SOURCE:{normalize_text(str(event.metadata.get('source') or ''))}"


def _build_rate_change(
    previous: FreightEvent,
    current_rate: Decimal | None,
    changed_at,
) -> RateChange | None:
    if previous.rate is None or current_rate is None or previous.rate == current_rate:
        return previous.rate_change
    delta = current_rate - previous.rate
    delta_percent = None
    if previous.rate != 0:
        delta_percent = (
            (delta / previous.rate) * Decimal("100")
        ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return RateChange(
        previous_rate=previous.rate,
        current_rate=current_rate,
        delta=delta,
        delta_percent=delta_percent,
        movement=RateMovement.INCREASE if delta > 0 else RateMovement.DECREASE,
        previous_timestamp=previous.timestamp,
        changed_at=changed_at,
    )


def _find_equivalent_offer_target(
    store: FreightStore,
    tenant_id: str,
    *,
    product: str | None,
    origin,
    destination,
    actor_identity: str,
    rate_unit: str | None,
) -> MatchContext | None:
    if not product or origin is None or destination is None:
        return None
    matches: list[MatchContext] = []
    for logical_key, event in store.recent_events(tenant_id, limit=100):
        if event.product != product:
            continue
        if not event.origin or not event.destination:
            continue
        if normalize_text(event.origin.normalized_value or "") != normalize_text(origin.normalized_value or ""):
            continue
        if normalize_text(event.destination.normalized_value or "") != normalize_text(destination.normalized_value or ""):
            continue
        if _event_actor(event) != actor_identity:
            continue
        if rate_unit and event.rate_unit and rate_unit != event.rate_unit:
            continue
        matches.append(MatchContext(logical_key, event, "stable_identity_match", 100))
    if len(matches) != 1:
        return None
    return matches[0]


@dataclass(frozen=True)
class MatchContext:
    logical_key: str
    event: FreightEvent
    method: str
    score: int


def _mutation_candidate_score(
    parsed: ParsedFreight,
    origin,
    destination,
    company,
    candidate: FreightEvent,
) -> int | None:
    score = 0
    candidate_company = _company(candidate)

    comparisons = [
        (parsed.product, candidate.product, 3),
        (
            origin.normalized_value if origin else None,
            candidate.origin.normalized_value if candidate.origin else None,
            3,
        ),
        (
            destination.normalized_value if destination else None,
            candidate.destination.normalized_value if candidate.destination else None,
            3,
        ),
        (
            company.normalized_value if company else None,
            candidate_company.normalized_value if candidate_company else None,
            2,
        ),
        (parsed.phone, candidate.metadata.get("phone"), 2),
        (parsed.date_text, candidate.metadata.get("date_text"), 1),
    ]
    for incoming, existing, weight in comparisons:
        if incoming is None or existing is None:
            continue
        if normalize_text(str(incoming)) != normalize_text(str(existing)):
            return None
        score += weight

    if parsed.rate is not None and candidate.rate is not None and parsed.rate == candidate.rate:
        score += 1
    return score


def _find_mutation_target(
    store: FreightStore,
    tenant_id: str,
    parsed: ParsedFreight,
    origin,
    destination,
    company,
    raw: RawInboundEvent,
) -> MatchContext | None:
    candidates = store.recent_events(tenant_id, limit=100)
    reply_to = raw.metadata.get("reply_to_source_event_id")
    if isinstance(reply_to, str) and reply_to:
        for logical_key, event in candidates:
            if reply_to not in event.source_event_ids:
                continue
            score = _mutation_candidate_score(parsed, origin, destination, company, event)
            if score is not None:
                return MatchContext(logical_key, event, "reply_source_event", score)

    ranked: list[MatchContext] = []
    for logical_key, event in candidates:
        score = _mutation_candidate_score(parsed, origin, destination, company, event)
        if score is None or score < 6:
            continue
        ranked.append(MatchContext(logical_key, event, "field_match", score))

    ranked.sort(key=lambda item: (item.score, item.event.timestamp), reverse=True)
    if not ranked:
        return None
    if len(ranked) > 1 and ranked[0].score == ranked[1].score:
        return None
    return ranked[0]


class FreightPipeline:
    def __init__(self, store: FreightStore, resolver: EntityResolver | None = None) -> None:
        self.store = store
        self.resolver = resolver or EntityResolver()

    def ingest(self, tenant_id: str, provider: str, raw: RawInboundEvent) -> IngestionResult:
        if self.store.has_source_event(tenant_id, provider, raw.source_event_id):
            return IngestionResult(
                status="DUPLICATE_SOURCE_EVENT",
                classification=FreightClassification.UNKNOWN,
                reason="source_event_id already processed",
            )

        raw_reference = self.store.save_raw(tenant_id, provider, raw)
        parsed = parse_freight(raw.raw_text)

        if parsed.classification in {
            FreightClassification.IRRELEVANT,
            FreightClassification.UNKNOWN,
            FreightClassification.INFORMATION,
        }:
            self.store.mark_source_event(tenant_id, provider, raw.source_event_id)
            return IngestionResult(
                status="CLASSIFIED_NO_FREIGHT_EVENT",
                classification=parsed.classification,
                reason="message preserved as raw but does not produce a canonical freight event",
            )

        origin = self.resolver.resolve("municipality", parsed.origin_raw)
        destination = self.resolver.resolve("municipality", parsed.destination_raw)
        company = self.resolver.resolve("company", parsed.company_raw)

        if parsed.classification in {
            FreightClassification.FREIGHT_OFFER,
            FreightClassification.FREIGHT_REQUEST,
        } and (parsed.product is None or origin is None or destination is None):
            self.store.mark_source_event(tenant_id, provider, raw.source_event_id)
            return IngestionResult(
                status="QUALITY_REJECTED",
                classification=parsed.classification,
                reason="product, origin and destination are required before canonical publication",
            )

        entities: dict[str, list] = {}
        if company:
            entities["company"] = [company]

        actor_identity = _incoming_actor(company, raw)
        key = _logical_key(
            [
                parsed.product,
                origin.normalized_value if origin else None,
                destination.normalized_value if destination else None,
                actor_identity,
                parsed.rate_unit,
            ]
        )
        previous = self.store.find_logical_event(tenant_id, key)
        match_method = "logical_key" if previous else None
        match_score: int | None = None

        if previous is None and parsed.classification in {
            FreightClassification.FREIGHT_OFFER,
            FreightClassification.FREIGHT_REQUEST,
        }:
            matched = _find_equivalent_offer_target(
                self.store,
                tenant_id,
                product=parsed.product,
                origin=origin,
                destination=destination,
                actor_identity=actor_identity,
                rate_unit=parsed.rate_unit,
            )
            if matched is not None:
                key = matched.logical_key
                previous = matched.event
                match_method = matched.method
                match_score = matched.score

        if previous is None and parsed.classification in {
            FreightClassification.UPDATE,
            FreightClassification.CANCELLATION,
        }:
            matched = _find_mutation_target(
                self.store,
                tenant_id,
                parsed,
                origin,
                destination,
                company,
                raw,
            )
            if matched is None:
                self.store.mark_source_event(tenant_id, provider, raw.source_event_id)
                return IngestionResult(
                    status="UNMATCHED_MUTATION",
                    classification=parsed.classification,
                    reason="update/cancellation could not be linked unambiguously to a prior freight event",
                )
            key = matched.logical_key
            previous = matched.event
            match_method = matched.method
            match_score = matched.score

        carried_forward_fields: list[str] = []
        if previous:
            if parsed.product is None:
                parsed_product = previous.product
                carried_forward_fields.append("product")
            else:
                parsed_product = parsed.product
            if origin is None:
                origin = previous.origin
                carried_forward_fields.append("origin")
            if destination is None:
                destination = previous.destination
                carried_forward_fields.append("destination")
            if company is None:
                company = _company(previous)
                if company:
                    entities["company"] = [company]
                    carried_forward_fields.append("company")
            if parsed.rate is None and parsed.classification == FreightClassification.CANCELLATION:
                event_rate = previous.rate
                event_rate_unit = previous.rate_unit
                carried_forward_fields.extend(["rate", "rate_unit"])
            else:
                event_rate = parsed.rate
                event_rate_unit = parsed.rate_unit or previous.rate_unit
            if parsed.date_text is None and previous.metadata.get("date_text"):
                date_text = previous.metadata.get("date_text")
                carried_forward_fields.append("date_text")
            else:
                date_text = parsed.date_text
            if parsed.phone is None and previous.metadata.get("phone"):
                phone = previous.metadata.get("phone")
                carried_forward_fields.append("phone")
            else:
                phone = parsed.phone
        else:
            parsed_product = parsed.product
            event_rate = parsed.rate
            event_rate_unit = parsed.rate_unit
            date_text = parsed.date_text
            phone = parsed.phone

        metadata = {
            "phone": phone,
            "date_text": date_text,
            "tonnage": str(parsed.tonnage) if parsed.tonnage is not None else None,
            "vacancies": parsed.vacancies,
            "links": parsed.links,
            "provider": provider,
            "source": raw.source,
            "actor_identity": actor_identity,
            "attachment_count": len(raw.attachments),
            "mutation_match_method": match_method,
            "mutation_match_score": match_score,
            "carried_forward_fields": sorted(set(carried_forward_fields)),
        }

        classification = parsed.classification
        version = 1
        event_id = None
        source_ids = [raw.source_event_id]
        rate_change = None
        if previous:
            event_id = previous.event_id
            version = previous.version
            source_ids = [*previous.source_event_ids, raw.source_event_id]
            if classification == FreightClassification.FREIGHT_OFFER and previous.classification in {
                FreightClassification.FREIGHT_OFFER,
                FreightClassification.UPDATE,
            }:
                if previous.rate != event_rate:
                    classification = FreightClassification.UPDATE
                else:
                    classification = previous.classification
            rate_change = _build_rate_change(previous, event_rate, raw.message_timestamp)

        event = FreightEvent(
            event_id=event_id or str(uuid4()),
            version=version,
            tenant_id=tenant_id,
            classification=classification,
            source_event_ids=source_ids,
            raw_reference=raw_reference,
            timestamp=raw.message_timestamp,
            product=parsed_product,
            origin=origin,
            destination=destination,
            entities=entities,
            rate=event_rate,
            rate_unit=event_rate_unit,
            rate_change=rate_change,
            metadata=metadata,
            confidence=parsed.confidence,
            truth_classification=TruthClassification.OBSERVED,
            provenance={
                "provider": provider,
                "source": raw.source,
                "source_event_id": raw.source_event_id,
                "message_timestamp": raw.message_timestamp.isoformat(),
                "mutation_match_method": match_method,
                "mutation_match_score": match_score,
                "actor_identity": actor_identity,
                "carried_forward_fields": sorted(set(carried_forward_fields)),
            },
        )

        if previous and _semantic_signature(previous) == _semantic_signature(event):
            event.version = previous.version
            self.store.save_event(event, key)
            self.store.mark_source_event(tenant_id, provider, raw.source_event_id)
            return IngestionResult(
                status="LOGICAL_REPOST",
                classification=event.classification,
                event=event,
                reason="observation attached to existing freight event without republishing",
            )

        if previous:
            event.version = previous.version + 1

        self.store.save_event(event, key)
        self.store.enqueue_outbox(event)
        self.store.mark_source_event(tenant_id, provider, raw.source_event_id)
        return IngestionResult(status="PUBLISHED_TO_OUTBOX", classification=event.classification, event=event)
