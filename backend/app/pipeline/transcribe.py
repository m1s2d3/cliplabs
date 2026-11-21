import gc
import os
import threading
import wave
from pathlib import Path
from typing import Callable

import numpy as np

from .. import config

_models: dict[str, object] = {}
_model_lock = threading.Lock()
# On memory-constrained hosts (e.g. 512MB free tiers), keeping the model resident
# while ffmpeg/opencv render clips risks an OOM kill; this trades reload time for lower peak RAM.
LOW_MEMORY = os.getenv("CLIPLABS_LOW_MEMORY", "").strip() == "1"


def model_for(language: str) -> str:
    return config.WHISPER_MODEL if language in ("auto", "en") else config.WHISPER_MULTILINGUAL_MODEL


def _get_model(name: str):
    with _model_lock:
        if name not in _models:
            from faster_whisper import WhisperModel

            _models[name] = WhisperModel(name, device="cpu", compute_type="int8")
    return _models[name]


def release_model() -> None:
    """Frees the cached Whisper model(s) after transcription when CLIPLABS_LOW_MEMORY=1."""
    if not LOW_MEMORY:
        return
    with _model_lock:
        _models.clear()
    gc.collect()



def transcribe(wav_path: Path, duration: float, on_progress: Callable[[float], None], language: str = "auto", offset: float = 0.0) -> dict:
    model = _get_model(model_for(language))
    # Pass raw samples so faster-whisper never touches PyAV, whose newer releases break its decoder.
    with wave.open(str(wav_path), "rb") as wav:
        audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    segments, info = model.transcribe(
        audio, language=None if language == "auto" else language, word_timestamps=True, vad_filter=True, beam_size=1
    )
    result, logprobs = [], []
    for segment in segments:
        words = [
            {"start": round(w.start + offset, 3), "end": round(w.end + offset, 3), "word": w.word.strip()}
            for w in (segment.words or [])
            if w.word.strip()
        ]
        result.append({"start": segment.start + offset, "end": segment.end + offset, "text": segment.text.strip(), "words": words})
        logprobs.append(segment.avg_logprob)
        if duration:
            on_progress(min(1.0, segment.end / duration))
    avg_logprob = float(np.mean(logprobs)) if logprobs else -10.0
    probability = 1.0 if language != "auto" else float(info.language_probability)
    return {
        "language": info.language,
        "language_probability": round(probability, 3),
        "avg_logprob": round(avg_logprob, 3),
        # Low language confidence or low token confidence usually means lyrics or noise, not usable speech.
        "reliable": probability >= 0.6 and avg_logprob > -0.9,
        "segments": result,
    }


def flatten_words(transcript: dict) -> list[dict]:
    return [word for segment in transcript.get("segments", []) for word in segment.get("words", [])]
