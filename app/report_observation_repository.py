from __future__ import annotations

from datetime import datetime

import psycopg

from .freight_reporting import FreightObservation


class ReportObservationRepository:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    @staticmethod
    def _set_tenant(cur, tenant_id: str) -> None:
        if not tenant_id or len(tenant_id) > 128:
            raise ValueError("invalid tenant_id")
        cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))

    def load_through(
        self,
        tenant_id: str,
        cutoff: datetime,
    ) -> list[FreightObservation]:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                SELECT
                    source_observation_id,
                    source_event_id,
                    source_line_number,
                    published_at,
                    received_at,
                    carrier,
                    product,
                    origin_ibge_code,
                    origin_city,
                    origin_uf,
                    destination_ibge_code,
                    destination_city,
                    destination_uf,
                    loading_point,
                    rate,
                    rate_unit,
                    toll_status,
                    vehicle_type,
                    vehicle_count,
                    offer_reference,
                    cargo_reference,
                    shipment_reference,
                    source_text_sha256,
                    extraction_confidence
                FROM whatsapp_freight_observations
                WHERE tenant_id=%s
                  AND validation_status='VALIDATED'
                  AND published_at <= %s
                  AND (received_at IS NULL OR received_at <= %s)
                ORDER BY published_at, source_observation_id
                """,
                (tenant_id, cutoff, cutoff),
            )
            rows = cur.fetchall()

        return [
            FreightObservation(
                source_observation_id=str(row[0]),
                source_event_id=str(row[1]),
                source_line_number=int(row[2]) if row[2] is not None else None,
                published_at=row[3],
                received_at=row[4],
                carrier=str(row[5]),
                product=str(row[6]),
                origin_ibge_code=str(row[7]),
                origin_city=str(row[8]),
                origin_uf=str(row[9]),
                destination_ibge_code=str(row[10]),
                destination_city=str(row[11]),
                destination_uf=str(row[12]),
                loading_point=str(row[13]),
                rate=row[14],
                rate_unit=str(row[15]),
                toll_status=str(row[16]),
                vehicle_type=str(row[17]) if row[17] is not None else None,
                vehicle_count=int(row[18]) if row[18] is not None else None,
                offer_reference=str(row[19]) if row[19] is not None else None,
                cargo_reference=str(row[20]) if row[20] is not None else None,
                shipment_reference=str(row[21]) if row[21] is not None else None,
                source_text_sha256=str(row[22]),
                extraction_confidence=float(row[23]),
            )
            for row in rows
        ]

    def last_observation_at(self, tenant_id: str) -> datetime | None:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                SELECT max(COALESCE(received_at, published_at))
                FROM whatsapp_freight_observations
                WHERE tenant_id=%s AND validation_status='VALIDATED'
                """,
                (tenant_id,),
            )
            row = cur.fetchone()
        return None if row is None or row[0] is None else row[0]
