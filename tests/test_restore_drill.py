from __future__ import annotations

from pathlib import Path

import pytest

from scripts.validate_restored_database import expected_migrations, restored_dsn

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_restored_dsn_retargets_only_cloud_sql_socket() -> None:
    source = (
        "postgresql://user:secret@/whatsapp_ai"
        "?host=%2Fcloudsql%2Fproject%3Aregion%3Asource&sslmode=disable"
    )
    restored = restored_dsn(source, "project:region:restore")
    assert "user:secret" in restored
    assert "whatsapp_ai" in restored
    assert "project%3Aregion%3Arestore" in restored
    assert "project%3Aregion%3Asource" not in restored


@pytest.mark.parametrize(
    "connection_name",
    ["", "project/region/instance"],
)
def test_restored_dsn_rejects_invalid_connection_name(connection_name: str) -> None:
    with pytest.raises(RuntimeError):
        restored_dsn("postgresql://u:p@/db", connection_name)


def test_validator_tracks_every_versioned_migration_checksum() -> None:
    expected = expected_migrations()
    migration_files = {path.name for path in (ROOT / "migrations").glob("*.sql")}
    assert set(expected) == migration_files
    assert all(len(checksum) == 64 for checksum in expected.values())


def test_restore_drill_is_non_destructive_and_guarded() -> None:
    script = read("scripts/backup_restore_drill_gcp.sh")
    assert 'ALLOW_BILLABLE_RESTORE_DRILL' in script
    assert '[[ "$target_instance" != "$SOURCE_INSTANCE" ]]' in script
    assert '"-restore-drill-"' in script
    assert 'gcloud sql backups create' in script
    assert 'gcloud sql backups restore "$backup_id"' in script
    assert '--restore-instance="$target_instance"' in script
    assert 'gcloud sql instances delete "$target_instance"' in script
    assert 'gcloud sql instances delete "$SOURCE_INSTANCE"' not in script


def test_restore_drill_validates_schema_migrations_rls_and_logs_evidence() -> None:
    validator = read("scripts/validate_restored_database.py")
    drill = read("scripts/backup_restore_drill_gcp.sh")
    assert "whatsapp_schema_migrations" in validator
    assert "relrowsecurity" in validator
    assert "relforcerowsecurity" in validator
    assert "RESTORE_VALIDATION_PASS" in validator
    assert "RESTORE_VALIDATION_PASS" in drill
    assert "RESTORE_DRILL_PASS" in drill


def test_restore_workflow_requires_dedicated_identity_and_billable_confirmation() -> None:
    workflow = read(".github/workflows/gcp-production-gate.yml")
    assert "restore-drill" in workflow
    assert "confirm_billable_restore_drill" in workflow
    assert "GCP_RESTORE_SERVICE_ACCOUNT" in workflow
    assert "Authenticate dedicated restore identity" in workflow
    assert 'CONFIRM_BILLABLE_RESTORE_DRILL' in workflow
    assert "ALLOW_BILLABLE_RESTORE_DRILL=1" in workflow


def test_bootstrap_creates_keyless_dedicated_restore_identity() -> None:
    bootstrap = read("scripts/bootstrap_gcp_admin.sh")
    assert "whatsapp-ai-restore-drill" in bootstrap
    assert "GCP_RESTORE_SERVICE_ACCOUNT" in bootstrap
    assert "roles/cloudsql.admin" in bootstrap
    assert "roles/run.admin" in bootstrap
    assert "roles/logging.viewer" in bootstrap
    assert 'DB_MIGRATOR_SECRET:$RESTORE_SA_EMAIL' in bootstrap
    assert 'roles/iam.workloadIdentityUser' in bootstrap
