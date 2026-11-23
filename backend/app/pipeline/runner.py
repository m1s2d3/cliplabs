import json
import logging
import time
from pathlib import Path
from typing import Callable

from .. import config, db
from .captions import build_groups
from .download import download_youtube
from .highlights import clock, find_highlights, make_title
from .media import PipelineError, audio_energy, extract_audio, probe, project_dir, save_waveform, scene_changes
from .render import render_clip
from .transcribe import flatten_words, model_for, release_model, transcribe

log = logging.getLogger(__name__)

STAGES = {"downloading": (0, 12), "transcribing": (12, 55), "analyzing": (55, 62), "rendering": (62, 99)}
DOWNLOAD_STAGES = {"downloading": (0, 99)}


class Cancelled(Exception):
    pass


class Reporter:
    def __init__(self, project_id: str, stages: dict = STAGES):
        self.project_id = project_id
        self.stages = stages
        self._last = 0.0

    def __call__(self, status: str, fraction: float, message: str, force: bool = False) -> None:
        stamp = time.monotonic()
        if not force and stamp - self._last < 0.75:
            return
        self._last = stamp
        if db.is_cancel_requested(self.project_id):
            raise Cancelled()
        lo, hi = self.stages[status]
        progress = round(lo + (hi - lo) * max(0.0, min(1.0, fraction)), 1)
        db.update_project(self.project_id, status=status, progress=progress, message=message)


def load_words(project_id: str) -> list[dict]:
    path = project_dir(project_id) / "transcript.json"
    if not path.exists():
        return []
    return flatten_words(json.loads(path.read_text()))


def run_project(project_id: str) -> None:
    project = db.get_project(project_id)
    if not project:
        return
    mode = project["mode"]
    report = Reporter(project_id, DOWNLOAD_STAGES if mode == "download" else STAGES)
    folder = project_dir(project_id)
    db.update_project(project_id, started_at=db.now(), finished_at=None)
    try:
        if db.is_cancel_requested(project_id):
            raise Cancelled()
        if mode == "download":
            message = _run_download(project, folder, report)
        else:
            source, meta = _prepare_source(project, folder, report)
            message = _run_cut(project_id, source, meta, folder, report) if mode == "cut" else _run_clips(project_id, source, meta, folder, report)
        db.update_project(project_id, status="done", progress=100, message=message, error=None, finished_at=db.now())
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, Cancelled) or db.is_cancel_requested(project_id):
            for clip in db.list_clips(project_id):
                if clip["status"] in ("queued", "rendering"):
                    db.update_clip(clip["id"], status="failed", error="Cancelled")
            db.update_project(project_id, status="cancelled", message="Cancelled", error=None, finished_at=db.now())
        elif isinstance(exc, PipelineError):
            log.warning("Project %s failed: %s", project_id, exc)
            db.update_project(project_id, status="failed", error=str(exc), message=None, finished_at=db.now())
        else:
            log.exception("Project %s crashed", project_id)
            db.update_project(project_id, status="failed", error=f"Unexpected error: {exc}", message=None, finished_at=db.now())
    finally:
        for leftover in ("audio.wav", "range.wav"):
            (folder / leftover).unlink(missing_ok=True)


def _prepare_source(project: dict, folder: Path, report: Reporter) -> tuple[Path, dict]:
    existing = Path(project["source_path"]) if project["source_path"] else None
    if project["source_type"] == "youtube" and not (existing and existing.exists()):
        report("downloading", 0, "Downloading video", force=True)
        options = project["options"]
        info = download_youtube(
            project["source_url"], folder,
            lambda f: report("downloading", f, f"Downloading video · {int(f * 100)}%"),
            range_start=options.get("range_start"), range_end=options.get("range_end"),
        )
        source = Path(info["path"])
        db.update_project(project["id"], title=info["title"][:200], channel=info["channel"], thumbnail=info["thumbnail"], source_path=str(source))
    else:
        source = existing
    meta = probe(source)
    if meta["duration"] > config.MAX_SOURCE_SECONDS:
        raise PipelineError(f"Video is longer than {config.MAX_SOURCE_SECONDS // 60} minutes")
    db.update_project(project["id"], duration=meta["duration"], width=meta["width"], height=meta["height"])
    return source, meta


def _analyze_audio(source: Path, folder: Path) -> tuple[Path, object, float]:
    wav = extract_audio(source, folder / "audio.wav")
    energy, window = audio_energy(wav)
    save_waveform(energy, window, folder / "waveform.json")
    return wav, energy, window


def _transcribe(wav: Path, length: float, language: str, report: Reporter, offset: float = 0.0) -> dict:
    note = " (first run downloads it)" if model_for(language) != config.WHISPER_MODEL else ""
    report("transcribing", 0, f"Loading the speech model{note}", force=True)
    result = transcribe(wav, length, lambda f: report("transcribing", f, f"Transcribing audio · {int(f * 100)}%"), language, offset)
    release_model()
    return result


def _clip_fields(start: float, end: float, words: list[dict], options: dict, **extra) -> dict:
    aspect = options.get("aspect", "9:16")
    if aspect == "custom" and options.get("output_width") and options.get("output_height"):
        aspect = f"custom:{options['output_width']}x{options['output_height']}"
    return {
        "start": round(start, 3),
        "end": round(end, 3),
        "captions": build_groups(words, start, end),
        "captions_enabled": options.get("captions", True),
        "caption_style": options.get("caption_style", "classic"),
        "aspect": aspect,
        "crop_mode": options.get("crop_mode", "auto"),
        "crop_x": None if options.get("find_facecam", True) else 0.5,
        "pip_position": options.get("pip_position", "bottom_right"),
        "pip_shape": options.get("pip_shape", "circle"),
        **extra,
    }


def _render_all(project_id: str, clips: list[dict], report: Reporter) -> int:
    rendered = 0
    for i, clip in enumerate(clips):
        label = f"Rendering clip {i + 1} of {len(clips)}"
        report("rendering", i / len(clips), label, force=True)
        if render_clip_job(clip["id"], lambda f, i=i, label=label: report("rendering", (i + f) / len(clips), label)):
            rendered += 1
    return rendered


def _run_clips(project_id: str, source: Path, meta: dict, folder: Path, report: Reporter) -> str:
    project = db.get_project(project_id)
    options = project["options"]
    music = options.get("content_type") == "music"
    duration = meta["duration"]
    is_trimmed_youtube = project["source_type"] == "youtube" and (options.get("range_start") is not None or options.get("range_end") is not None)
    span = (0.0, duration) if is_trimmed_youtube else (min(options.get("range_start") or 0.0, duration), min(options.get("range_end") or duration, duration))
    if span[1] - span[0] < options["min_length"]:
        raise PipelineError("The selected range is shorter than the minimum clip length")
    if not meta["has_audio"]:
        raise PipelineError("This video has no audio track, so there is nothing to analyze")

    wav, energy, window = _analyze_audio(source, folder)
    transcript = _transcribe(wav, duration, options.get("language", "auto"), report)
    (folder / "transcript.json").write_text(json.dumps(transcript))
    db.update_project(project_id, language=transcript["language"])
    words = flatten_words(transcript)
    if len(words) < 5 and not music:
        raise PipelineError("No speech was detected in this video. For songs, choose the Music content type.")

    report("analyzing", 0.35, "Detecting scene changes", force=True)
    scenes = scene_changes(source)
    ai = " with AI" if config.OPENAI_API_KEY and transcript["reliable"] and not music else ""
    report("analyzing", 0.75, f"Ranking the most engaging moments{ai}", force=True)
    highlights = find_highlights(
        words, transcript["segments"], energy, window, scenes, duration,
        options["clip_count"], options["min_length"], options["max_length"],
        options.get("content_type", "talking"), project["title"], transcript["reliable"], span,
    )
    if not highlights:
        raise PipelineError("Couldn't find complete moments in that length range. Try a shorter clip length.")

    clips = []
    for idx, h in enumerate(highlights):
        start, end = max(0.0, h["start"] - 0.15), min(duration, h["end"] + 0.4)
        clips.append(db.insert_clip(project_id, _clip_fields(
            start, end, words, options, idx=idx, title=h["title"], hook=h.get("hook"), reason=h.get("reason"), score=h["score"],
            score_breakdown=h.get("breakdown"), description=h.get("description"), hashtags=h.get("hashtags"),
            crop_mode=options.get("crop_mode", "split" if options.get("content_type") == "gaming" and options.get("aspect", "9:16") == "9:16" else "auto"),
        )))
    rendered = _render_all(project_id, clips, report)
    if rendered == 0:
        raise PipelineError("All clips failed to render")
    return f"{rendered} clips ready"


def _run_cut(project_id: str, source: Path, meta: dict, folder: Path, report: Reporter) -> str:
    project = db.get_project(project_id)
    options = project["options"]
    start, end = options["start"], min(options["end"], meta["duration"])
    if end - start < 1:
        raise PipelineError("The cut range is outside the video")
    words: list[dict] = []
    if meta["has_audio"]:
        _analyze_audio(source, folder)
        if options.get("captions"):
            wav = extract_audio(source, folder / "range.wav", start, end - start)
            transcript = _transcribe(wav, end - start, options.get("language", "auto"), report, offset=start)
            (folder / "transcript.json").write_text(json.dumps(transcript))
            db.update_project(project_id, language=transcript["language"])
            words = flatten_words(transcript)

    title = f"{make_title(project['title'], 40).rstrip('…')} · {clock(start)}–{clock(end)}"
    clip = db.insert_clip(project_id, _clip_fields(
        start, end, words, options, idx=0, title=title, reason="Manual cut", score=0,
        crop_mode="center", description=project["title"], hashtags=[],
    ))
    if not _render_all(project_id, [clip], report):
        raise PipelineError(db.get_clip(clip["id"])["error"] or "Rendering failed")
    return "Your cut is ready"


def _run_download(project: dict, folder: Path, report: Reporter) -> str:
    options = project["options"]
    kind = options.get("kind", "video")
    noun = "audio" if kind == "audio" else "video"
    report("downloading", 0, f"Downloading {noun}", force=True)
    info = download_youtube(
        project["source_url"], folder, lambda f: report("downloading", f, f"Downloading {noun} · {int(f * 100)}%"),
        stem="download", kind=kind, quality=options.get("quality", "1080"), audio_format=options.get("audio_format", "m4a"),
        range_start=options.get("range_start"), range_end=options.get("range_end"),
    )
    path = Path(info["path"])
    db.update_project(
        project["id"], title=info["title"][:200], channel=info["channel"], thumbnail=info["thumbnail"],
        duration=info["duration"], output_path=str(path), output_size=path.stat().st_size,
    )
    return f"Your {noun} is ready"


def render_clip_job(clip_id: str, on_progress: Callable[[float], None] = lambda _: None) -> bool:
    clip = db.get_clip(clip_id)
    project = db.get_project(clip["project_id"]) if clip else None
    if not clip or not project:
        return False
    db.update_clip(clip_id, status="rendering", error=None)
    try:
        source = Path(project["source_path"])
        video, thumb = render_clip(
            source,
            project_dir(project["id"]) / "clips",
            clip_id,
            clip["start"],
            clip["end"],
            project["width"],
            project["height"],
            probe(source)["has_audio"],
            clip["captions"] if clip["captions_enabled"] else None,
            on_progress,
            aspect=clip["aspect"],
            caption_style=clip["caption_style"],
            caption_position=clip["caption_position"],
            crop_mode=clip["crop_mode"],
            crop_x=clip["crop_x"],
            crop_x2=clip["crop_x2"],
            crop_y=clip["crop_y"],
            crop_y2=clip["crop_y2"],
            crop_zoom=clip["crop_zoom"],
            crop_zoom2=clip["crop_zoom2"],
            hook_text=clip["hook"] if clip["hook_enabled"] else None,
            hook_duration=clip["hook_duration"],
            resolution=project["options"].get("output_resolution", 1080),
            output_fps=project["options"].get("frame_rate", config.OUTPUT_FPS),
            pip_position=clip["pip_position"],
            pip_shape=clip["pip_shape"],
            camera_area=clip["crop_area"] or project["options"].get("facecam_area"),
            gameplay_area=clip["crop_area2"] or project["options"].get("gameplay_area"),
        )
        db.update_clip(clip_id, status="ready", video_path=str(video), thumb_path=str(thumb) if thumb.exists() else None)
        return True
    except Cancelled:
        db.update_clip(clip_id, status="failed", error="Cancelled")
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("Clip %s failed to render", clip_id)
        db.update_clip(clip_id, status="failed", error=str(exc))
        return False
