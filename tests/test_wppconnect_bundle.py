from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_wppconnect_is_pinned_and_only_local_api_is_published() -> None:
    compose = read("provider/wppconnect/docker-compose.yml")
    assert "wppconnect/wppconnect-server:sha-c192518" in compose
    assert '127.0.0.1:21465:21465' in compose
    assert "bridge:" in compose
    bridge_block = compose.split("bridge:", 1)[1].split("wppconnect:", 1)[0]
    assert "ports:" not in bridge_block


def test_wpp_and_bridge_secrets_are_split() -> None:
    compose = read("provider/wppconnect/docker-compose.yml")
    assert "bridge.env" in compose
    assert "wpp.env" in compose
    bridge_block = compose.split("bridge:", 1)[1].split("wppconnect:", 1)[0]
    wpp_block = compose.split("wppconnect:", 1)[1]
    assert "bridge.env" in bridge_block
    assert "wpp.env" not in bridge_block
    assert "wpp.env" in wpp_block
    assert "bridge.env" not in wpp_block


def test_wpp_runtime_disables_media_download_and_side_effects() -> None:
    entry = read("provider/wppconnect/wpp-entrypoint.cjs")
    assert "autoDownload: false" in entry
    assert "uploadS3: false" in entry
    assert "readMessage: false" in entry
    assert "allUnreadOnStart: false" in entry
    assert "listenAcks: false" in entry
    assert "onPresenceChanged: false" in entry
    assert "onParticipantsChanged: false" in entry
    assert "onSelfMessage: false" in entry
    assert "MANAGER_ENABLED = 'false'" in entry


def test_setup_never_prints_secrets_and_verifies_cloud_mapping() -> None:
    setup = read("provider/wppconnect/setup.sh")
    assert "gcloud secrets versions access latest" in setup
    assert "hmac.compare_digest" in setup
    assert "chmod 600 bridge.env wpp.env" in setup
    assert "docker compose config --quiet" in setup
    assert 'echo "$provider_hmac"' not in setup
    assert 'echo "$wpp_secret"' not in setup
    assert 'echo "$outbox_key"' not in setup


def test_local_secret_and_queue_files_are_gitignored() -> None:
    ignore = read(".gitignore")
    assert "provider/wppconnect/bridge.env" in ignore
    assert "provider/wppconnect/wpp.env" in ignore
    assert "*.sqlite3" in ignore


def test_bridge_runs_non_root_with_persistent_volume() -> None:
    dockerfile = read("Dockerfile")
    compose = read("provider/wppconnect/docker-compose.yml")
    assert "USER 65532:65532" in dockerfile
    assert "chown 65532:65532 /data/bridge" in dockerfile
    assert "bridge_data:/data/bridge" in compose
    assert "no-new-privileges:true" in compose
    assert "cap_drop:" in compose
