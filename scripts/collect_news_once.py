"""Run the opt-in, source-scoped RSS/Atom collector once.

This is a collection probe, not a scheduled production ingestion pipeline.
It never sends WhatsApp messages or persists news in the freight database.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx

from app.news_collection import NewsCollectionPolicy, collect_feed
from app.news_delivery_format import news_idempotency_key

MAX_CONFIG_BYTES = 131_072


def load_policy(path: Path) -> NewsCollectionPolicy:
    if path.stat().st_size > MAX_CONFIG_BYTES:
        raise ValueError("news registry exceeds 128 KiB")
    return NewsCollectionPolicy.model_validate_json(path.read_bytes())


def collect_once(policy: NewsCollectionPolicy) -> list[dict[str, object]]:
    """Returns candidate records only, with no durable or remote side effects."""
    items: list[dict[str, object]] = []
    for source in policy.sources:
        if not source.enabled:
            continue
        try:
            selected = collect_feed(source, policy)
        except (httpx.HTTPError, ValueError) as exc:
            # Do not print possibly attacker-controlled response text/URLs.
            print(
                f"news source failed: {source.source_id} ({type(exc).__name__})",
                file=sys.stderr,
            )
            continue
        for article in selected:
            items.append(
                {
                    "idempotency_key": news_idempotency_key(article),
                    "article": article.model_dump(mode="json"),
                }
            )
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect approved RSS/Atom news once")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    policy = load_policy(args.config)
    for article in collect_once(policy):
        print(json.dumps(article, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
