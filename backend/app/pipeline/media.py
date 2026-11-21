import json
import re
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np

from .. import config


class PipelineError(Exception):
    pass


def project_dir(project_id: str) -> Path:
    path = (config.MEDIA_DIR / project_id).resolve()
    if config.MEDIA_DIR.resolve() not in path.parents:
        raise PipelineError("Invalid project path")
    path.mkdir(parents=True, exist_ok=True)
    return path


def remove_project_dir(project_id: str) -> None:
    path = (config.MEDIA_DIR / project_id).resolve()
    if config.MEDIA_DIR.resolve() in path.parents and path.exists():
        shutil.rmtree(path)


def media_url(path: str | None) -> str | None:
    if not path:
        return None
    relative = Path(path).resolve().relative_to(config.MEDIA_DIR.resolve())
    return f"/media/{relative.as_posix()}"


def run(cmd: list[str], timeout: int | None = None) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise PipelineError(f"{cmd[0]} is not installed") from exc
    if result.returncode != 0:
        tail = "\n".join(result.stderr.strip().splitlines()[-6:])
        raise PipelineError(f"{Path(cmd[0]).name} failed: {tail}")
    return result


def probe(path: Path) -> dict:
    result = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], timeout=120)
    data = json.loads(result.stdout or "{}")
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if not video:
        raise PipelineError("The file does not contain a video stream")
    has_audio = any(s.get("codec_type") == "audio" for s in data.get("streams", []))
    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
    width, height = int(video["width"]), int(video["height"])
    rotation = _rotation(video)
    if rotation in (90, 270):
        width, height = height, width
    num, _, den = (video.get("avg_frame_rate") or "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    return {"duration": duration, "width": width, "height": height, "fps": fps or 30.0, "has_audio": has_audio}


def _rotation(stream: dict) -> int:
    for side in stream.get("side_data_list", []) or []:
        if "rotation" in side:
            return abs(int(side["rotation"])) % 360
    return abs(int(stream.get("tags", {}).get("rotate", 0))) % 360


def extract_audio(source: Path, dest: Path, start: float | None = None, duration: float | None = None) -> Path:
    span = (["-ss", f"{start:.3f}"] if start else []) + (["-t", f"{duration:.3f}"] if duration else [])
    run(["ffmpeg", "-y", "-v", "error", *span, "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dest)])
    return dest


def save_waveform(energy: np.ndarray, window: float, dest: Path, points_per_second: float = 4.0) -> None:
    """Stores a small normalized loudness curve for the editor timeline."""
    step = max(1, int(round(1 / (window * points_per_second))))
    trimmed = energy[: len(energy) // step * step].reshape(-1, step).max(axis=1) if len(energy) >= step else energy
    peak = float(trimmed.max()) if trimmed.size else 1.0
    values = (trimmed / (peak or 1.0)).round(3).tolist()
    dest.write_text(json.dumps({"interval": window * step, "values": values}))


def audio_energy(wav_path: Path, window: float = 0.5) -> tuple[np.ndarray, float]:
    """Returns RMS loudness per window and the window length in seconds."""
    with wave.open(str(wav_path), "rb") as wav:
        rate = wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32)
    size = max(1, int(rate * window))
    usable = len(samples) // size * size
    if usable == 0:
        return np.zeros(1, dtype=np.float32), window
    frames = samples[:usable].reshape(-1, size)
    return np.sqrt(np.mean(frames ** 2, axis=1)), window


_PTS_RE = re.compile(r"pts_time:([0-9.]+)")


def scene_changes(source: Path, threshold: float = 0.3) -> list[float]:
    try:
        result = run(
            ["ffmpeg", "-hide_banner", "-i", str(source), "-an", "-vf", f"fps=4,scale=320:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
            timeout=1800,
        )
    except PipelineError:
        return []
    return [float(m) for m in _PTS_RE.findall(result.stderr)]
