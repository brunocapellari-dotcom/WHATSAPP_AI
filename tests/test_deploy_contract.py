from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_production_workflow_is_manual_and_uses_wif() -> None:
    workflow = read(".github/workflows/gcp-production-gate.yml")
    assert "workflow_dispatch:" in workflow
    assert "\n  push:" not in workflow
    assert "id-token: write" in workflow
    assert "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093" in workflow
    assert "GCP_WORKLOAD_IDENTITY_PROVIDER" in workflow


def test_recurring_deploy_does_not_bootstrap_admin_resources() -> None:
    preflight = read("scripts/preflight_gcp.sh")
    deploy = read("scripts/deploy_gcp.sh")
    combined = preflight + "\n" + deploy
    forbidden = (
        "gcloud services enable",
        "add-iam-policy-binding",
        "gcloud sql instances create",
        "gcloud secrets create",
        "gcloud iam service-accounts create",
    )
    for command in forbidden:
        assert command not in combined


def test_ingress_stays_private_and_has_dependency_probes() -> None:
    deploy = read("scripts/deploy_gcp.sh")
    assert "--no-allow-unauthenticated" in deploy
    assert "\n  --allow-unauthenticated" not in deploy
    assert 'httpGet.path=/readyz' in deploy
    assert 'httpGet.path=/healthz' in deploy
    assert "allAuthenticatedUsers" in deploy
    assert "allUsers" in deploy


def test_migrations_run_before_ingress_and_privileged_job_is_deleted() -> None:
    deploy = read("scripts/deploy_gcp.sh")
    migrate = deploy.index('gcloud run jobs deploy "$MIGRATION_JOB_NAME"')
    ingress = deploy.index('gcloud run deploy "$INGRESS_SERVICE_NAME"')
    assert migrate < ingress
    assert 'gcloud run jobs delete "$MIGRATION_JOB_NAME"' in deploy
    assert "scripts.release_migrate" in deploy


def test_worker_is_tenant_scoped_and_does_not_receive_raw_key() -> None:
    deploy = read("scripts/deploy_gcp.sh")
    start = deploy.index('gcloud run jobs deploy "$WORKER_JOB_NAME"')
    end = deploy.index('echo "Running worker smoke execution"')
    worker_block = deploy[start:end]
    assert "WHATSAPP_WORKER_TENANT_ID" in worker_block
    assert "AGROLOG_OIDC_AUDIENCE" in worker_block
    assert "AGROLOG_SHARED_SECRET" in worker_block
    assert "DATABASE_URL_WORKER" in worker_block
    assert "RAW_KEY_SECRET" not in worker_block
    assert "WHATSAPP_RAW_ENCRYPTION_KEY_B64" not in worker_block


def test_runtime_image_contains_release_migrations_without_root_runtime() -> None:
    dockerfile = read("Dockerfile")
    assert "COPY migrations ./migrations" in dockerfile
    assert "COPY scripts ./scripts" in dockerfile
    assert "USER 65532:65532" in dockerfile


def test_preflight_requires_private_agrolog_and_worker_invoker() -> None:
    preflight = read("scripts/preflight_gcp.sh")
    assert "AgroLog freight service has a broad public invoker binding" in preflight
    assert "worker service account lacks service-level roles/run.invoker" in preflight
