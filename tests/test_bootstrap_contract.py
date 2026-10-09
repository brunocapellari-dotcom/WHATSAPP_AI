from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_bootstrap_requires_explicit_billable_opt_in_and_capacity() -> None:
    script = read("scripts/bootstrap_gcp_admin.sh")
    assert 'ALLOW_BILLABLE_INFRA' in script
    assert '[[ "$ALLOW_BILLABLE_INFRA" == "1" ]]' in script
    assert "CLOUD_SQL_CPU must be explicit" in script
    assert "CLOUD_SQL_MEMORY_MB must be explicit" in script
    assert "CLOUD_SQL_STORAGE_GB must be explicit" in script
    assert "CLOUD_SQL_AVAILABILITY_TYPE must be ZONAL or REGIONAL" in script


def test_bootstrap_provisions_data_protection_by_default() -> None:
    script = read("scripts/bootstrap_gcp_admin.sh")
    assert "--enable-point-in-time-recovery" in script
    assert "--retained-backups-count=14" in script
    assert "--retained-transaction-log-days=7" in script
    assert "--deletion-protection" in script
    assert "--enable-password-policy" in script


def test_bootstrap_uses_secret_manager_and_wif_not_service_account_keys() -> None:
    script = read("scripts/bootstrap_gcp_admin.sh")
    assert "gcloud secrets versions add" in script
    assert "workload-identity-pools providers create-oidc" in script
    assert "repository_id" in script
    assert "repository_owner_id" in script
    assert "refs/heads/main" in script
    assert "USER_MANAGED service-account key found" in script
    assert "service-accounts keys create" not in script


def test_runtime_credentials_are_split_by_role() -> None:
    script = read("scripts/bootstrap_gcp_admin.sh")
    assert "whatsapp-ai-database-url" in script
    assert "whatsapp-ai-database-url-worker" in script
    assert "whatsapp-ai-database-url-migrator" in script
    assert "whatsapp-ai-raw-encryption-key" in script
    assert "whatsapp-ai-webhook-secrets" in script
    assert "whatsapp-ai-provider-webhook-secret" in script


def test_release_migration_revokes_cloudsql_superuser_from_runtime() -> None:
    migration = read("scripts/release_migrate.py")
    assert 'REVOKE cloudsqlsuperuser FROM {}' in migration
    assert migration.count('REVOKE cloudsqlsuperuser FROM {}') == 2
    assert "GRANT whatsapp_ingestor" in migration
    assert "GRANT whatsapp_worker" in migration


def test_bootstrap_grants_worker_only_required_agrolog_invocation() -> None:
    script = read("scripts/bootstrap_gcp_admin.sh")
    assert "AGROLOG_SERVICE_NAME" in script
    assert "roles/run.invoker" in script
    assert "roles/secretmanager.secretAccessor" in script
