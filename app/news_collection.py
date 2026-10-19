"""Opt-in RSS/Atom source registry and topic filtering for news candidates.

Strictly separate collection/selection from summary generation and distribution.
External articles are untrusted data; no text in feeds can change policy.
"""
from __future__ import annotations

import hashlib
import ipaddress
import re
import unicodedata
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from urllib.parse import urlsplit

import httpx
from defusedxml import ElementTree as SafeET
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

from .news_delivery_format import NewsDispatchItem

MAX_FEED_BYTES = 1_000_000
MAX_FEED_ENTRIES = 100
ATOM_NS = "{http://www.w3.org/2005/Atom}"


def _normalized(value: str) -> str:
    value = unicodedata.normalize("NFKD", value.casefold())
    value = "".join(char for char in value if not unicodedata.combining(char))
    return " ".join(re.findall(r"[a-z0-9]+", value))


def _contains_phrase(normalized_haystack: str, phrase: str) -> bool:
    needle = _normalized(phrase)
    return bool(needle and f" {needle} " in f" {normalized_haystack} ")


def _public_https_host(value: HttpUrl) -> str:
    host = (value.host or "").lower().rstrip(".")
    if value.scheme != "https" or value.username or value.password:
        raise ValueError("source URL must be HTTPS without credentials")
    if (
        not host
        or "." not in host
        or host.startswith(".")
        or host.endswith((".localhost", ".local", ".internal", ".test", ".invalid"))
        or host in {"localhost", "metadata.google.internal"}
    ):
        raise ValueError("source URL must have a public DNS hostname")
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return host
    raise ValueError("source URL cannot be a literal IP address")


class NewsTopicRule(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    topic_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,63}$")
    display_name: str = Field(min_length=1, max_length=40)
    include_terms: list[str] = Field(min_length=1, max_length=80)
    exclude_terms: list[str] = Field(default_factory=list, max_length=80)

    @field_validator("include_terms", "exclude_terms")
    @classmethod
    def valid_terms(cls, terms: list[str]) -> list[str]:
        result = []
        for term in terms:
            if not isinstance(term, str) or not 2 <= len(term.strip()) <= 90:
                raise ValueError("topic terms must be 2-90 characters")
            if not _normalized(term):
                raise ValueError("topic terms cannot be punctuation only")
            result.append(term.strip())
        return result


class NewsSourceRule(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    source_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,63}$")
    provider: str = Field(min_length=1, max_length=120)
    feed_url: HttpUrl
    allowed_topic_ids: list[str] = Field(min_length=1, max_length=30)
    enabled: bool = False

    @field_validator("feed_url")
    @classmethod
    def public_feed_url(cls, value: HttpUrl) -> HttpUrl:
        _public_https_host(value)
        return value


class NewsCollectionPolicy(BaseModel):
    """Nothing is collected unless explicitly enabled per approved source."""

    model_config = ConfigDict(extra="forbid")
    topics: list[NewsTopicRule] = Field(default_factory=list, max_length=100)
    sources: list[NewsSourceRule] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def valid_references(self) -> NewsCollectionPolicy:
        topic_ids = [item.topic_id for item in self.topics]
        source_ids = [item.source_id for item in self.sources]
        if len(topic_ids) != len(set(topic_ids)) or len(source_ids) != len(
            set(source_ids)
        ):
            raise ValueError("source and topic identifiers must be unique")
        known = set(topic_ids)
        for source in self.sources:
            if not set(source.allowed_topic_ids) <= known:
                raise ValueError("source refers to an unknown topic")
            if len(source.allowed_topic_ids) != len(set(source.allowed_topic_ids)):
                raise ValueError("source topic assignments must be unique")
        return self


class _HTMLText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _plain(value: str) -> str:
    parser = _HTMLText()
    parser.feed(value[:10000])
    parser.close()
    return " ".join(" ".join(parser.parts).split())[:2000]


def _element_text(element: object, name: str) -> str:
    from xml.etree.ElementTree import Element

    if not isinstance(element, Element):
        return ""
    child = element.find(name)
    return ("".join(child.itertext()) if child is not None else "").strip()


def _date(value: str) -> datetime | None:
    if not value:
        return None
    try:
        timestamp = parsedate_to_datetime(value)
    except (ValueError, TypeError, IndexError):
        try:
            timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        return None
    return timestamp.astimezone(UTC)


class FeedArticle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(min_length=1, max_length=256)
    headline: str = Field(min_length=1, max_length=280)
    description: str = Field(max_length=2000)
    published_at: datetime
    url: HttpUrl


def parse_feed(content: bytes) -> list[FeedArticle]:
    """Parse bounded RSS/Atom bytes without DTD, entities or external fetches."""
    if not 0 < len(content) <= MAX_FEED_BYTES:
        raise ValueError("feed size outside accepted range")
    try:
        root = SafeET.fromstring(content)
    except Exception as exc:
        raise ValueError("feed XML invalid or prohibited") from exc
    if root.tag in {"rss", "RDF", "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}RDF"}:
        entries = root.findall("./channel/item") or root.findall("./item")
        atom = False
    elif root.tag == f"{ATOM_NS}feed":
        entries = root.findall(f"./{ATOM_NS}entry")
        atom = True
    else:
        raise ValueError("unsupported feed type")
    articles: list[FeedArticle] = []
    for item in entries[:MAX_FEED_ENTRIES]:
        if atom:
            headline = _element_text(item, f"{ATOM_NS}title")
            description = _element_text(item, f"{ATOM_NS}summary")
            if not description:
                description = _element_text(item, f"{ATOM_NS}content")
            publication = _element_text(item, f"{ATOM_NS}published")
            event_id = _element_text(item, f"{ATOM_NS}id")
            link = ""
            for candidate in item.findall(f"{ATOM_NS}link"):
                if candidate.attrib.get("rel", "alternate") == "alternate":
                    link = candidate.attrib.get("href", "")
                    break
        else:
            headline = _element_text(item, "title")
            description = _element_text(item, "description")
            publication = _element_text(item, "pubDate")
            event_id = _element_text(item, "guid")
            link = _element_text(item, "link")
        headline = _plain(headline)[:280]
        published_at = _date(publication)
        if not headline or not published_at or not link:
            continue
        try:
            parsed = HttpUrl(link)
            _public_https_host(parsed)
        except (ValueError, TypeError):
            continue
        identifier = (event_id or link).strip()
        if len(identifier) > 256:
            identifier = hashlib.sha256(identifier.encode("utf-8")).hexdigest()
        articles.append(
            FeedArticle(
                event_id=identifier,
                headline=headline,
                description=_plain(description),
                published_at=published_at,
                url=parsed,
            )
        )
    return articles


def select_news(
    policy: NewsCollectionPolicy,
    source_id: str,
    articles: list[FeedArticle],
) -> list[NewsDispatchItem]:
    """Only allow configured source/topic pairs. Never fabricate article summaries."""
    source = next((source for source in policy.sources if source.source_id == source_id), None)
    if source is None or not source.enabled:
        return []
    topics = {topic.topic_id: topic for topic in policy.topics}
    accepted: list[NewsDispatchItem] = []
    seen_events: set[str] = set()
    for article in articles:
        if article.event_id in seen_events:
            continue
        corpus = _normalized(f"{article.headline} {article.description}")
        matched: list[str] = []
        for topic_id in source.allowed_topic_ids:
            topic = topics[topic_id]
            if any(_contains_phrase(corpus, x) for x in topic.exclude_terms):
                continue
            if any(_contains_phrase(corpus, x) for x in topic.include_terms):
                matched.append(topic.display_name)
        if matched:
            accepted.append(
                NewsDispatchItem(
                    source_id=source.source_id,
                    source_event_id=article.event_id,
                    published_at=article.published_at,
                    instruments=matched[:5],
                    headline=article.headline,
                    provider=source.provider,
                    source_url=article.url,
                    short_summary=None,  # Summarization requires a separate approved stage.
                )
            )
            seen_events.add(article.event_id)
    return accepted


def collect_feed(
    source: NewsSourceRule,
    policy: NewsCollectionPolicy,
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[NewsDispatchItem]:
    """One bounded pull from a single preapproved RSS/Atom HTTPS endpoint.

    This is not a scheduler or sender; the caller owns state and authorization.
    The exact URL is preconfigured; redirects and environmental proxies are off.
    Outbound network egress policy must also constrain hosts in deployment.
    """
    if not source.enabled or source not in policy.sources:
        return []
    original_host = _public_https_host(source.feed_url)
    url = str(source.feed_url)
    if urlsplit(url).hostname != original_host:
        raise ValueError("feed host mismatch")
    body = bytearray()
    with httpx.Client(
        transport=transport,
        timeout=httpx.Timeout(10.0, connect=5.0),
        follow_redirects=False,
        trust_env=False,
    ) as client:
        with client.stream("GET", url, headers={"Accept": "application/rss+xml, application/atom+xml, application/xml"}) as response:
            if response.status_code != 200:
                raise ValueError(f"RSS/Atom source returned HTTP {response.status_code}")
            content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if content_type not in {
                "application/rss+xml",
                "application/atom+xml",
                "application/xml",
                "text/xml",
            }:
                raise ValueError("news source did not serve an XML feed")
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > MAX_FEED_BYTES:
                    raise ValueError("feed exceeds allowed response size")
    return select_news(policy, source.source_id, parse_feed(bytes(body)))
