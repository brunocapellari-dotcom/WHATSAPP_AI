"""Report delivery must not queue unapproved or unhealthy publication."""
from datetime import datetime

import pytest

from app.freight_reporting import MT_TIMEZONE
from app.report_delivery import ReportDeliveryQueue


def test_delivery_queue_validates_tenant_kind_and_cutoff_before_database() -> None:
    queue = ReportDeliveryQueue("postgresql://not-connected")
    slot = datetime(2026, 10, 16, 14, tzinfo=MT_TIMEZONE)
    with pytest.raises(ValueError, match="tenant_id"):
        queue.queue_authorized("", slot, "FULL")
    with pytest.raises(ValueError, match="invalid report kind"):
        queue.queue_authorized("tenant-a", slot, "OTHER")
    with pytest.raises(ValueError, match="exactly"):
        queue.queue_authorized(
            "tenant-a", datetime(2026, 10, 16, 13, tzinfo=MT_TIMEZONE), "FULL"
        )
