from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


def utc_now() -> datetime:
    return datetime.now(UTC)


class FreightClassification(StrEnum):
    FREIGHT_OFFER = "FREIGHT_OFFER"
    FREIGHT_REQUEST = "FREIGHT_REQUEST"
    UPDATE = "UPDATE"
    CANCELLATION = "CANCELLATION"
    INFORMATION = "INFORMATION"
    IRRELEVANT = "IRRELEVANT"
    UNKNOWN = "UNKNOWN"


class TruthClassification(StrEnum):
    OBSERVED = "OBSERVADO"
    INFERRED = "INFERIDO"
    ESTIMATED = "ESTIMADO"
    EXTERNALLY_CONFIRMED = "CONFIRMADO_EXTERNAMENTE"


class AttachmentMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attachment_id: str = Field(min_length=1, max_length=256)
    filename: str | None = Field(default=None, max_length=512)
    mime_type: str | None = Field(default=None, max_length=128)
    size_bytes: int | None = Field(default=None, ge=0, le=50_000_000)
    content_hash: str | None = Field(default=None, max_length=128)
    storage_reference: str | None = Field(default=None, max_length=2048)


class RawInboundEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_event_id: str = Field(min_length=1, max_length=256)
    source: str = Field(min_length=1, max_length=256)
    message_timestamp: datetime
    raw_text: str = Field(default="", max_length=50_000)
    raw_event: dict[str, Any] = Field(default_factory=dict)
    attachments: list[AttachmentMetadata] = Field(default_factory=list, max_length=20)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EntityValue(BaseModel):
    raw_value: str
    normalized_value: str | None = None
    canonical_id: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class FreightEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(default_factory=lambda: str(uuid4()))
    version: int = Field(default=1, ge=1)
    tenant_id: str
    classification: FreightClassification
    source_event_ids: list[str]
    raw_reference: str
    timestamp: datetime
    product: str | None = None
    origin: EntityValue | None = None
    destination: EntityValue | None = None
    entities: dict[str, list[EntityValue]] = Field(default_factory=dict)
    rate: Decimal | None = None
    rate_unit: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    truth_classification: TruthClassification = TruthClassification.OBSERVED
    provenance: dict[str, Any] = Field(default_factory=dict)

    @field_validator("source_event_ids")
    @classmethod
    def unique_source_ids(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(values))


class IngestionResult(BaseModel):
    status: str
    classification: FreightClassification
    event: FreightEvent | None = None
    reason: str | None = None
