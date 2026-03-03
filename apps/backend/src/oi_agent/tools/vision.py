from __future__ import annotations

import base64
import logging
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)

_vision_model: Any = None


def _get_vision_model() -> Any:
    """Lazy-init the Gemini model for vision analysis."""
    global _vision_model
    if _vision_model is not None:
        return _vision_model

    try:
        from google import genai

        client = genai.Client(
            vertexai=settings.google_genai_use_vertexai,
            project=settings.gcp_project,
            location=settings.gcp_location,
        )
        _vision_model = client
    except Exception as exc:
        raise RuntimeError(f"Failed to init Gemini vision client: {exc}") from exc

    return _vision_model


async def analyze_image(
    image_bytes: bytes,
    mime_type: str = "image/jpeg",
    prompt: str = "Describe what you see in this image.",
) -> str:
    """Send an image to Gemini Vision and return the text description."""
    client = _get_vision_model()

    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=[
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": image_b64,
                        }
                    },
                ],
            }
        ],
    )

    return response.text or "Could not analyze the image."


async def analyze_image_url(
    image_url: str,
    prompt: str = "Describe what you see in this image.",
) -> str:
    """Analyze an image from a URL using Gemini Vision."""
    client = _get_vision_model()

    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=[
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {"file_data": {"file_uri": image_url, "mime_type": "image/jpeg"}},
                ],
            }
        ],
    )

    return response.text or "Could not analyze the image."
