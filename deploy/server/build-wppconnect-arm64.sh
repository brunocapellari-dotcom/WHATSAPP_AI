#!/usr/bin/env bash
set -euo pipefail
umask 077

# Architecture pilot. No external deployment, port opening or cloud account
# mutation. Uses a reviewed, exact upstream commit matching the existing tag.
SOURCE_REPO="https://github.com/wppconnect-team/wppconnect-server.git"
SOURCE_SHA="c19251895e03922d302bffada6b5a4f8383fe5ae"
IMAGE="whatsapp-ai/wppconnect-arm64:$SOURCE_SHA"

for cmd in git docker; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd" >&2; exit 2; }
done

host_arch="$(uname -m)"
if [[ "$host_arch" != "aarch64" && "$host_arch" != "arm64" ]]; then
  echo "REFUSED: this native build needs an ARM64 host (found: $host_arch)." >&2
  exit 2
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

git -C "$work_dir" init -q
git -C "$work_dir" remote add origin "$SOURCE_REPO"
git -C "$work_dir" fetch --depth 1 origin "$SOURCE_SHA"
git -C "$work_dir" checkout --detach -q FETCH_HEAD
actual_sha="$(git -C "$work_dir" rev-parse HEAD)"
[[ "$actual_sha" == "$SOURCE_SHA" ]] || {
  echo "REFUSED: upstream commit verification failed" >&2
  exit 3
}

# Native image including Chromium, sharp and pinned WPPConnect dependencies.
# This is only a candidate: it MUST pass real QR/session and channel tests.
docker build --pull --platform linux/arm64 --tag "$IMAGE" "$work_dir"
docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}'
echo "ARM64_BUILD_COMPLETE (NOT PRODUCTION VALIDATED): $IMAGE"
