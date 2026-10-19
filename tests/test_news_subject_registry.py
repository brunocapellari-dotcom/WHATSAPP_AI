"""Policy/agribusiness relevance guard for the user-approved news subjects."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.news_collection import (
    FeedArticle,
    NewsCollectionPolicy,
    NewsSourceRule,
    NewsTopicRule,
    select_news,
)

CONFIG_FILE = (
    Path(__file__).resolve().parents[1] / "config" / "news_collection.example.json"
)


def approved_policy() -> NewsCollectionPolicy:
    config = NewsCollectionPolicy.model_validate_json(CONFIG_FILE.read_bytes())
    assert config.sources == []
    return NewsCollectionPolicy(
        topics=config.topics,
        sources=[
            NewsSourceRule(
                source_id="approved-news",
                provider="Fonte fictícia para testes",
                feed_url="https://news.example.org/feed.xml",
                enabled=True,
                allowed_topic_ids=[topic.topic_id for topic in config.topics],
            )
        ],
    )


def classify(headline: str, description: str = "") -> set[str]:
    article = FeedArticle(
        event_id=headline,
        headline=headline,
        description=description,
        published_at=datetime(2026, 10, 19, 12, 0, tzinfo=UTC),
        url="https://news.example.org/item/123",
    )
    selected = select_news(approved_policy(), "approved-news", [article])
    return set(selected[0].instruments) if selected else set()


def test_example_registry_lists_every_requested_subject_without_activating_sources() -> None:
    config = NewsCollectionPolicy.model_validate_json(CONFIG_FILE.read_bytes())
    assert config.sources == []
    assert {topic.topic_id for topic in config.topics} == {
        "politica_geopolitica",
        "safra_soja",
        "safra_milho",
        "safra_algodao",
        "boi_gordo",
        "bezerro",
        "combustiveis",
        "custos_producao",
        "meteorologia",
        "previsao_tempo",
    }
    assert json.loads(CONFIG_FILE.read_text(encoding="utf-8"))["sources"] == []


@pytest.mark.parametrize(
    ("headline", "expected"),
    [
        ("Guerra eleva preço do petróleo e pressiona diesel", "Política / Geopolítica"),
        ("Tarifas comerciais sobre soja elevam custos de exportação", "Política / Geopolítica"),
        ("Sanções restringem exportação de fertilizantes", "Política / Geopolítica"),
        ("Política agrícola eleva custo de produção de soja", "Política / Geopolítica"),
        ("Safra de soja tem produtividade revisada", "Safra de soja"),
        ("Colheita de milho avança no Centro-Oeste", "Safra de milho"),
        ("Plantio do algodão alcança nova área", "Safra de algodão"),
        ("Cotação do boi gordo sobe", "Boi gordo"),
        ("Bezerro de reposição tem alta de preço", "Bezerro"),
        ("Preços do óleo diesel são reajustados", "Combustíveis"),
        ("Custos de produção agrícola aumentam", "Custos de produção"),
        ("Alerta meteorológico prevê chuvas intensas", "Meteorologia"),
        ("Previsão do tempo indica chuva em Mato Grosso", "Previsão do tempo"),
    ],
)
def test_user_requested_subject_is_classified(headline: str, expected: str) -> None:
    assert expected in classify(headline)


@pytest.mark.parametrize(
    "headline",
    [
        "Debate sobre eleição de prefeito movimenta a cidade",
        "Guerra domina manchetes de política internacional",
        "Tarifas de ingresso de cinema mudam",
        "Soja é tema de festival gastronômico",
        "Milho vira decoração de festa",
        "Algodão é tema de desfile de moda",
        "Futebol e clima político dominam eleição local",
    ],
)
def test_unrelated_general_news_does_not_trigger(headline: str) -> None:
    assert classify(headline) == set()


def test_price_only_story_is_not_confused_with_crop_production() -> None:
    assert "Safra de soja" not in classify("Preço da soja sobe em Chicago")
    assert "Safra de milho" not in classify("Milho encerra pregão em alta")


def test_politics_requires_both_market_context_and_impact() -> None:
    assert "Política / Geopolítica" not in classify(
        "Eleição presidencial tem nova pesquisa eleitoral"
    )
    assert "Política / Geopolítica" not in classify(
        "Eleição internacional terá debates sobre petróleo"
    )
    assert "Política / Geopolítica" in classify(
        "Eleição provoca alta do dólar e pressiona custos de insumos"
    )


def test_single_publication_can_cover_multiple_topics_once() -> None:
    article = FeedArticle(
        event_id="combined-1",
        headline="Guerra eleva preço do diesel e custo de produção de soja",
        description="",
        published_at=datetime(2026, 10, 19, 11, 0, tzinfo=UTC),
        url="https://news.example.org/item/combined-1",
    )
    accepted = select_news(approved_policy(), "approved-news", [article, article])
    assert len(accepted) == 1
    assert "Política / Geopolítica" in accepted[0].instruments
    assert "Combustíveis" in accepted[0].instruments
    assert "Custos de produção" in accepted[0].instruments


@pytest.mark.parametrize(
    "groups",
    [
        [[]],
        [[""]],
        [["*"]],
        [["ok", 3]],
        [["a"] * 81],
    ],
)
def test_required_term_groups_must_be_valid(groups: list[list[str]]) -> None:
    with pytest.raises(ValidationError):
        NewsTopicRule(
            topic_id="test",
            display_name="Teste",
            include_terms=["relevante"],
            required_term_groups=groups,
        )
