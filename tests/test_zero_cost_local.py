from __future__ import annotations

from pathlib import Path

import pytest

from app.security import SecurityError, validate_egress_url

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_zero_cost_compose_has_no_cloud_dependency() -> None:
    compose = read("deploy/local/docker-compose.yml")
    forbidden = (
        "cloud.google.com",
        "gcloud ",
        "cloudsql",
        "run.app",
        "cloudarmor",
        "load-balancing",
    )
    for value in forbidden:
        assert value not in compose.lower()


def test_postgres_is_not_published_and_uses_internal_network() -> None:
    compose = read("deploy/local/docker-compose.yml")
    postgres = compose.split("  postgres:", 1)[1].split("\n  migrate:", 1)[0]
    assert "ports:" not in postgres
    assert "- data_net" in postgres
    assert "- delivery_net" not in postgres
    assert "internal: true" in compose


def test_only_localhost_operational_ports_are_published() -> None:
    compose = read("deploy/local/docker-compose.yml")
    assert '"127.0.0.1:${LOCAL_INGRESS_PORT:-8080}:8080"' in compose
    assert '"127.0.0.1:${LOCAL_WPP_PORT:-21465}:21465"' in compose
    assert '"0.0.0.0:' not in compose


def test_delivery_worker_is_opt_in_and_has_no_raw_key() -> None:
    compose = read("deploy/local/docker-compose.yml")
    worker = compose.split("  worker:", 1)[1].split("\n  bridge:", 1)[0]
    assert 'profiles: ["delivery"]' in worker
    assert "WHATSAPP_RAW_ENCRYPTION_KEY_B64" not in worker
    assert "AGROLOG_ALLOW_PRIVATE_HTTP" in worker
    assert "- delivery_net" in worker


def test_bridge_private_http_is_explicit_and_hmac_remains_required() -> None:
    compose = read("deploy/local/docker-compose.yml")
    bridge = compose.split("  bridge:", 1)[1].split("\n  wppconnect:", 1)[0]
    assert "BRIDGE_ALLOW_PRIVATE_HTTP" in bridge
    assert "BRIDGE_PROVIDER_HMAC_SECRET" in bridge
    assert "BRIDGE_EGRESS_ALLOWED_HOSTS: ingress" in bridge
    assert "http://ingress:8080/v1/providers/" in bridge


def test_setup_does_not_print_secret_values() -> None:
    setup = read("deploy/local/setup.sh")
    assert "chmod 600 .env" in setup
    assert "Do not upload, paste or commit deploy/local/.env." in setup
    assert "cat .env" not in setup
    assert "echo $PROVIDER_HMAC_SECRET" not in setup
    assert "echo $WPP_SECRET_KEY" not in setup


def test_backup_and_restore_drill_are_present() -> None:
    backup = read("deploy/local/backup.sh")
    restore = read("deploy/local/restore-drill.sh")
    assert "pg_dump" in backup
    assert "sha256sum" in backup
    assert "pg_restore" in restore
    assert "DROP DATABASE IF EXISTS" in restore
    assert "LOCAL_RESTORE_DRILL_PASS" in restore
    assert "refusing an unverified backup" in restore
    assert "relforcerowsecurity" in restore
    assert "whatsapp_schema_migrations" in restore
    assert "sha256sum" in restore


def test_private_http_egress_is_fail_closed() -> None:
    assert (
        validate_egress_url(
            "http://ingress:8080/v1/providers/wppconnect/events",
            {"ingress"},
            allow_private_http=True,
        )
        == "http://ingress:8080/v1/providers/wppconnect/events"
    )
    assert (
        validate_egress_url(
            "http://host.docker.internal:8000/v1/freight/events",
            {"host.docker.internal"},
            allow_private_http=True,
        )
        == "http://host.docker.internal:8000/v1/freight/events"
    )
    with pytest.raises(SecurityError):
        validate_egress_url(
            "http://evil.example.com/collect",
            {"evil.example.com"},
            allow_private_http=True,
        )
    with pytest.raises(SecurityError):
        validate_egress_url(
            "http://127.0.0.1:8000/collect",
            {"127.0.0.1"},
            allow_private_http=True,
        )



def test_windows_launcher_keeps_setup_and_pairing_minimal() -> None:
    launcher = read("deploy/local/zero-cost.ps1")
    assert 'Invoke-LocalBashScript "setup.sh"' in launcher
    assert 'Invoke-LocalBashScript "start.sh"' in launcher
    assert 'Invoke-LocalBashScript "pair.sh"' in launcher
    assert 'Start-Process $QrFile' in launcher
    assert "Get-Content $EnvFile" not in launcher
    assert "Write-Host $EnvFile" not in launcher
