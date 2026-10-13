from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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


class RateMovement(StrEnum):
    INCREASE = "AUMENTO"
    DECREASE = "REDUCAO"


class RateChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    previous_rate: Decimal = Field(ge=0)
    current_rate: Decimal = Field(ge=0)
    delta: Decimal
    delta_percent: Decimal | None = None
    movement: RateMovement
    previous_timestamp: datetime
    changed_at: datetime

    @model_validator(mode="after")
    def validate_consistency(self) -> RateChange:
        expected_delta = self.current_rate - self.previous_rate
        if expected_delta == 0:
            raise ValueError("rate change must change the advertised rate")
        if self.delta != expected_delta:
            raise ValueError("rate change delta is inconsistent")
        expected_movement = (
            RateMovement.INCREASE if expected_delta > 0 else RateMovement.DECREASE
        )
        if self.movement != expected_movement:
            raise ValueError("rate change movement is inconsistent")
        if self.changed_at < self.previous_timestamp:
            raise ValueError("rate change timestamp precedes previous observation")
        return self


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
    rate_change: RateChange | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    truth_classification: TruthClassification = TruthClassification.OBSERVED
    provenance: dict[str, Any] = Field(default_factory=dict)

    @field_validator("source_event_ids")
    @classmethod
    def unique_source_ids(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(values))

    @model_validator(mode="after")
    def validate_rate_change_matches_current_rate(self) -> FreightEvent:
        if self.rate_change is not None and self.rate != self.rate_change.current_rate:
            raise ValueError("rate_change current_rate must match event rate")
        return self


class IngestionResult(BaseModel):
    status: str
    classification: FreightClassification
    event: FreightEvent | None = None
    reason: str | None = None
