from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.news_delivery_format import (
    NewsDispatchItem,
    news_idempotency_key,
    news_row,
    render_news_whatsapp,
)


def news(**updates: object) -> NewsDispatchItem:
    payload: dict[str, object] = {
        "source_id": "noticias-agricolas",
        "source_event_id": "article-123",
        "published_at": datetime(2026, 10, 19, 12, 12, tzinfo=UTC),
        "instruments": ["Soja", "Milho"],
        "headline": "Soja abre estável em Chicago",
        "provider": "Notícias Agrícolas",
        "source_url": "https://www.noticiasagricolas.com.br/artigos/123",
        "short_summary": "Negociações seguem próximas da estabilidade.",
    }
    payload.update(updates)
    return NewsDispatchItem.model_validate(payload)


def test_news_row_matches_feed_columns_and_provenance() -> None:
    item = news()
    row = news_row(item)
    assert row.tempo == "19/10/2026 08:12"
    assert row.instrumento == "Soja / Milho"
    assert row.titulo == item.headline
    assert row.provedor == item.provider
    assert row.resumo == item.short_summary
    assert row.fonte_url == str(item.source_url)
    assert row.publicado_em == "2026-10-19T12:12:00+00:00"
    assert len(row.idempotency_key) == 64


def test_alert_is_readable_and_has_no_invented_analysis() -> None:
    rendered = render_news_whatsapp(news())
    assert rendered.startswith("*Últimas notícias*\n*Tempo:*")
    assert "*Instrumento:* Soja / Milho" in rendered
    assert "*Título:* Soja abre estável em Chicago" in rendered
    assert "*Provedor:* Notícias Agrícolas" in rendered
    assert "*Resumo:* Negociações seguem próximas da estabilidade." in rendered
    assert "*Fonte:* https://www.noticiasagricolas.com.br/artigos/123" in rendered
    assert "impacto:" not in rendered.casefold()
    assert "análise:" not in rendered.casefold()


def test_missing_summary_is_omitted_not_fabricated() -> None:
    rendered = render_news_whatsapp(news(short_summary=None))
    assert "*Resumo:*" not in rendered
    assert "*Título:*" in rendered


def test_repeated_article_has_stable_id_but_distinct_provider_does_not() -> None:
    first = news()
    assert news_idempotency_key(first) == news_idempotency_key(news())
    assert news_idempotency_key(first) != news_idempotency_key(
        news(source_id="reuters")
    )
    assert news_idempotency_key(first) != news_idempotency_key(
        news(source_event_id="article-124")
    )


@pytest.mark.parametrize(
    "invalid",
    [
        "http://news.example.org/story",
        "https://localhost/story",
        "https://127.0.0.1/story",
        "https://192.168.1.5/story",
        "https://user:pass@news.example.org/story",
        "https://collector.internal/story",
    ],
)
def test_rejects_unsafe_article_links(invalid: str) -> None:
    with pytest.raises(ValidationError):
        news(source_url=invalid)


def test_rejects_naive_publication_timestamp() -> None:
    with pytest.raises(ValidationError):
        news(published_at=datetime(2026, 10, 19, 8, 12))


def test_preserves_multiple_instruments_without_repeating_same_label() -> None:
    row = news_row(news(instruments=["Soja", "soja", "Milho"]))
    assert row.instrumento == "Soja / Milho"


def test_untrusted_news_text_does_not_insert_extra_whatsapp_fields() -> None:
    rendered = render_news_whatsapp(
        news(
            headline="*Soja*\n*Provedor:* falso",
            provider="Agência\n*Fonte:* falsa",
            short_summary="Informação \n*Análise:* falsa",
        )
    )
    assert "*Título:* Soja Provedor: falso" in rendered
    assert "*Provedor:* Agência Fonte: falsa" in rendered
    assert "*Resumo:* Informação Análise: falsa" in rendered
    assert rendered.count("\n*Fonte:*") == 1


def test_requires_source_backed_fields_and_disallows_extra_data() -> None:
    with pytest.raises(ValidationError):
        news(headline="")
    with pytest.raises(ValidationError):
        news(instruments=[])
    with pytest.raises(ValidationError):
        news(unsupported_field="not accepted")
