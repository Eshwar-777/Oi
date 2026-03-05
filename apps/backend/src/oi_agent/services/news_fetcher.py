"""News fetcher using Gemini with Google Search grounding.

Fetches real-time news on a given topic and returns structured results.
Uses Vertex AI's Gemini model with Google Search as a grounding tool
so answers reflect live web data instead of training-data knowledge.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)

_genai_client: Any = None


def _get_genai_client() -> Any:
    global _genai_client
    if _genai_client is not None:
        return _genai_client

    from google import genai

    if settings.google_genai_use_vertexai:
        _genai_client = genai.Client(
            vertexai=True,
            project=settings.gcp_project,
            location=settings.gcp_location,
        )
    else:
        _genai_client = genai.Client()
    return _genai_client


async def fetch_news(
    topic: str,
    *,
    max_items: int = 10,
    language: str = "en",
) -> list[dict[str, Any]]:
    """Fetch recent news articles about *topic* via Gemini + Google Search grounding.

    Returns a list of dicts with keys: title, snippet, url, published_at.
    """
    from google.genai import types

    client = _get_genai_client()

    google_search_tool = types.Tool(
        google_search=types.GoogleSearch(),
    )

    prompt = (
        f"Find the {max_items} most recent and important news articles about: {topic}\n\n"
        f"Language: {language}\n"
        f"Current date: {datetime.utcnow().strftime('%Y-%m-%d')}\n\n"
        "For each article, provide:\n"
        "1. title — the article headline\n"
        "2. snippet — a 2-3 sentence summary of the article\n"
        "3. url — the source URL\n"
        "4. source — the publication name\n"
        "5. published_at — the publication date (ISO format if available, otherwise approximate)\n\n"
        "Return ONLY a valid JSON array. No markdown fences, no explanation."
    )

    try:
        response = await client.aio.models.generate_content(
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                tools=[google_search_tool],
                temperature=0.2,
            ),
        )

        raw_text = response.text.strip()
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[1]
            if raw_text.endswith("```"):
                raw_text = raw_text[: raw_text.rfind("```")]

        import json
        articles = json.loads(raw_text)

        if not isinstance(articles, list):
            articles = [articles]

        normalized: list[dict[str, Any]] = []
        for art in articles[:max_items]:
            normalized.append({
                "title": art.get("title", "Untitled"),
                "snippet": art.get("snippet", art.get("summary", "")),
                "url": art.get("url", art.get("link", "")),
                "source": art.get("source", ""),
                "published_at": art.get("published_at", art.get("date", datetime.utcnow().isoformat())),
            })

        logger.info("Fetched %d news items for topic=%s", len(normalized), topic)
        return normalized

    except Exception as exc:
        logger.error("News fetch failed for topic=%s: %s", topic, exc)
        return [{
            "title": f"News fetch failed: {exc}",
            "snippet": "The news service encountered an error. Will retry on next schedule.",
            "url": "",
            "source": "system",
            "published_at": datetime.utcnow().isoformat(),
        }]
