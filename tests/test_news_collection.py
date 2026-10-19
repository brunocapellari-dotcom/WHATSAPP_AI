from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from pydantic import ValidationError

from app.news_collection import (
    MAX_FEED_BYTES,
    NewsCollectionPolicy,
    NewsSourceRule,
    NewsTopicRule,
    collect_feed,
    parse_feed,
    select_news,
)
from app.news_delivery_format import news_idempotency_key, news_row

RSS = b"""<?xml version="1.0"?>
<rss version="2.0"><channel><title>Fonte de teste</title>
<item><title>Soja: compras chinesas no radar</title>
<guid>id-soja</guid><link>https://news.example.org/story/1</link>
<description>Commodities agricolas</description><pubDate>Mon, 19 Oct 2026 11:12:00 GMT</pubDate></item>
<item><title>Milho tem novas perspectivas</title>
<guid>id-milho</guid><link>https://news.example.org/story/2</link>
<description>Mercado agricola</description><pubDate>Mon, 19 Oct 2026 10:45:00 GMT</pubDate></item>
<item><title>Futebol: time e campeao</title>
<guid>id-futebol</guid><link>https://news.example.org/story/3</link>
<description>Campeonato regional</description><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Soja: compras chinesas no radar</title>
<guid>id-soja</guid><link>https://news.example.org/story/1</link>
<description>Republicacao</description><pubDate>Mon, 19 Oct 2026 11:12:00 GMT</pubDate></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>tag:news.example.org,2026:1</id>
<title>Mercado de milho avanca</title><summary>Safra americana em debate</summary>
<link rel="alternate" href="https://news.example.org/milho/1"/>
<published>2026-10-19T12:00:00Z</published></entry>
</feed>"""


def policy(*, enabled: bool = True) -> NewsCollectionPolicy:
    return NewsCollectionPolicy(
        topics=[
            NewsTopicRule(
                topic_id="soja",
                display_name="Soja",
                include_terms=["soja", "soybean", "soybeans"],
                exclude_terms=["soja de papel"],
            ),
            NewsTopicRule(
                topic_id="milho",
                display_name="Milho",
                include_terms=["milho", "corn"],
            ),
        ],
        sources=[
            NewsSourceRule(
                source_id="agencia",
                provider="Agência teste",
                feed_url="https://news.example.org/rss.xml",
                allowed_topic_ids=["soja", "milho"],
                enabled=enabled,
            )
        ],
    )


def test_filter_only_approved_source_topic_pairs() -> None:
    config = policy()
    selected = select_news(config, "agencia", parse_feed(RSS))
    assert [item.source_event_id for item in selected] == ["id-soja", "id-milho"]
    assert [item.instruments for item in selected] == [["Soja"], ["Milho"]]
    assert all(item.short_summary is None for item in selected)
    assert selected[0].provider == "Agência teste"
    assert news_row(selected[0]).tempo == "19/10/2026 07:12"
    assert news_idempotency_key(selected[0]) == news_idempotency_key(selected[0])


def test_disabled_source_yields_no_news() -> None:
    config = policy(enabled=False)
    assert select_news(config, "agencia", parse_feed(RSS)) == []
    assert collect_feed(config.sources[0], config) == []
    assert select_news(config, "unknown-source", parse_feed(RSS)) == []


def test_independent_source_topic_permissions() -> None:
    config = policy()
    config.sources[0].allowed_topic_ids = ["milho"]
    assert [item.source_event_id for item in select_news(config, "agencia", parse_feed(RSS))] == [
        "id-milho"
    ]


def test_atom_is_supported_without_reinventing_news_text() -> None:
    items = select_news(policy(), "agencia", parse_feed(ATOM))
    assert len(items) == 1
    assert items[0].instruments == ["Milho"]
    assert items[0].published_at == datetime(2026, 10, 19, 12, 0, tzinfo=UTC)


def test_phrase_boundaries_and_accent_normalization() -> None:
    item = parse_feed(
        RSS.replace(
            b"Soja: compras chinesas no radar",
            b"Embarque de SOJA: compras chinesas",
        )
    )[0]
    assert select_news(policy(), "agencia", [item])
    # "milho" must not match an unrelated word such as "milhoes".
    unmatched = item.model_copy(
        update={"headline": "Milhoes em vendas", "description": "Economia geral"}
    )
    assert select_news(policy(), "agencia", [unmatched]) == []


def test_topic_exclusions_take_precedence() -> None:
    article = parse_feed(RSS)[0].model_copy(
        update={"headline": "Soja de papel: mostra cultural"}
    )
    assert select_news(policy(), "agencia", [article]) == []


def test_http_pull_accepts_exact_configured_feed_only() -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "application/rss+xml"}, content=RSS)

    config = policy()
    selected = collect_feed(
        config.sources[0], config, transport=httpx.MockTransport(handler)
    )
    assert len(selected) == 2
    assert requests == ["https://news.example.org/rss.xml"]


@pytest.mark.parametrize("status", [301, 302, 307, 401, 429, 500])
def test_http_pull_does_not_follow_redirects_or_accept_errors(status: int) -> None:
    config = policy()
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            status,
            headers={"location": "http://localhost/internal"},
        )
    )
    with pytest.raises(ValueError, match=f"HTTP {status}"):
        collect_feed(config.sources[0], config, transport=transport)


def test_http_pull_rejects_oversize_xml() -> None:
    config = policy()
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/rss+xml"},
            content=b"a" * (MAX_FEED_BYTES + 1),
        )
    )
    with pytest.raises(ValueError, match="size"):
        collect_feed(config.sources[0], config, transport=transport)


def test_feed_blocks_xml_entities() -> None:
    hostile = (
        b'<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
        b"<rss><channel><item><title>&x;</title></item></channel></rss>"
    )
    with pytest.raises(ValueError, match="prohibited"):
        parse_feed(hostile)


def test_does_not_assume_missing_publication_dates() -> None:
    feed = RSS.replace(
        b"<pubDate>Mon, 19 Oct 2026 11:12:00 GMT</pubDate>",
        b"",
        1,
    )
    assert all(x.event_id != "id-soja" for x in parse_feed(feed))


@pytest.mark.parametrize(
    "host",
    [
        "http://news.example.org/rss.xml",
        "https://localhost/rss",
        "https://10.0.0.1/rss",
        "https://metadata.google.internal/rss",
        "https://user:password@news.example.org/rss",
    ],
)
def test_disallows_private_or_insecure_feed_hosts(host: str) -> None:
    with pytest.raises(ValidationError):
        NewsSourceRule(
            source_id="agencia",
            provider="Agência",
            feed_url=host,
            allowed_topic_ids=["milho"],
            enabled=True,
        )


def test_policy_rejects_nonexistent_topic_or_duplicate_sources() -> None:
    config = policy()
    source = config.sources[0]
    with pytest.raises(ValidationError, match="unknown topic"):
        NewsCollectionPolicy(
            topics=config.topics,
            sources=[source.model_copy(update={"allowed_topic_ids": ["trigo"]})],
        )
    with pytest.raises(ValidationError, match="unique"):
        NewsCollectionPolicy(topics=config.topics, sources=[source, source])


def test_news_requires_opt_in_per_source() -> None:
    source = NewsSourceRule(
        source_id="nova-fonte",
        provider="Fonte teste",
        feed_url="https://news.example.org/feed",
        allowed_topic_ids=["soja"],
    )
    assert source.enabled is False
