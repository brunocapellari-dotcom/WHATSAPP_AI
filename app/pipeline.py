from __future__ import annotations

import hashlib
import json
from decimal import Decimal

from .models import FreightClassification, FreightEvent, IngestionResult, RawInboundEvent, TruthClassification
from .parser import EntityResolver, normalize_text, parse_freight
from .storage import FreightStore


def _logical_key(parts: list[str | None]) -> str:
    normalized = "|".join(normalize_text(part or "") for part in parts)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


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
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()


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
        entities: dict[str, list] = {}
        company = self.resolver.resolve("company", parsed.company_raw)
        if company:
            entities["company"] = [company]

        key = _logical_key([
            parsed.product,
            origin.normalized_value if origin else None,
            destination.normalized_value if destination else None,
            company.normalized_value if company else None,
            parsed.date_text,
        ])
        previous = self.store.find_logical_event(tenant_id, key)

        metadata = {
            "phone": parsed.phone,
            "date_text": parsed.date_text,
            "tonnage": str(parsed.tonnage) if parsed.tonnage is not None else None,
            "vacancies": parsed.vacancies,
            "links": parsed.links,
            "provider": provider,
            "source": raw.source,
            "attachment_count": len(raw.attachments),
        }

        classification = parsed.classification
        version = 1
        event_id = None
        source_ids = [raw.source_event_id]
        if previous:
            event_id = previous.event_id
            version = previous.version
            source_ids = [*previous.source_event_ids, raw.source_event_id]
            if classification == FreightClassification.FREIGHT_OFFER and previous.rate != parsed.rate:
                classification = FreightClassification.UPDATE

        event = FreightEvent(
            event_id=event_id or FreightEvent.model_fields["event_id"].default_factory(),
            version=version,
            tenant_id=tenant_id,
            classification=classification,
            source_event_ids=source_ids,
            raw_reference=raw_reference,
            timestamp=raw.message_timestamp,
            product=parsed.product,
            origin=origin,
            destination=destination,
            entities=entities,
            rate=parsed.rate,
            rate_unit=parsed.rate_unit,
            metadata=metadata,
            confidence=parsed.confidence,
            truth_classification=TruthClassification.OBSERVED,
            provenance={
                "provider": provider,
                "source": raw.source,
                "source_event_id": raw.source_event_id,
                "message_timestamp": raw.message_timestamp.isoformat(),
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
