from __future__ import annotations

import logging
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)

_tts_client: Any = None
_stt_client: Any = None


def _get_tts_client() -> Any:
    """Lazy-init Google Cloud Text-to-Speech client."""
    global _tts_client
    if _tts_client is not None:
        return _tts_client

    try:
        from google.cloud import texttospeech

        _tts_client = texttospeech.TextToSpeechAsyncClient()
    except Exception as exc:
        raise RuntimeError(f"Failed to init TTS client: {exc}") from exc

    return _tts_client


def _get_stt_client() -> Any:
    """Lazy-init Google Cloud Speech-to-Text client."""
    global _stt_client
    if _stt_client is not None:
        return _stt_client

    try:
        from google.cloud import speech

        _stt_client = speech.SpeechAsyncClient()
    except Exception as exc:
        raise RuntimeError(f"Failed to init STT client: {exc}") from exc

    return _stt_client


async def text_to_speech(text: str) -> bytes:
    """Convert text to audio bytes using Google Cloud TTS.

    Returns audio in LINEAR16 format.
    """
    from google.cloud import texttospeech

    client = _get_tts_client()

    synthesis_input = texttospeech.SynthesisInput(text=text)
    voice_params = texttospeech.VoiceSelectionParams(
        language_code=settings.tts_language_code,
        name=settings.tts_voice_name,
    )
    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.LINEAR16,
        sample_rate_hertz=24000,
    )

    response = await client.synthesize_speech(
        input=synthesis_input,
        voice=voice_params,
        audio_config=audio_config,
    )

    return response.audio_content


async def speech_to_text(audio_bytes: bytes, sample_rate: int = 16000) -> str:
    """Convert audio bytes to text using Google Cloud STT.

    Expects LINEAR16 encoded audio.
    """
    from google.cloud import speech

    client = _get_stt_client()

    audio = speech.RecognitionAudio(content=audio_bytes)
    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=sample_rate,
        language_code=settings.tts_language_code,
        enable_automatic_punctuation=True,
    )

    response = await client.recognize(config=config, audio=audio)

    transcript_parts: list[str] = []
    for result in response.results:
        if result.alternatives:
            transcript_parts.append(result.alternatives[0].transcript)

    return " ".join(transcript_parts).strip() or ""
