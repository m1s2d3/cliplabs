import re
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from .. import config
from .media import PipelineError

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}


def validate_youtube_url(url: str) -> str:
    url = (url or "").strip()
    if not url or len(url) > 2048:
        raise ValueError("Paste a YouTube link")
    parsed = urlparse(url if "://" in url else f"https://{url}")
    if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() not in YOUTUBE_HOSTS:
        raise ValueError("Only YouTube links are supported")
    if parsed.username or parsed.password or parsed.port not in (None, 80, 443):
        raise ValueError("Only YouTube links are supported")
    return parsed.geturl()


def _clean(exc: Exception) -> str:
    message = re.sub(r"\x1b\[[0-9;]*m", "", str(exc))
    return re.sub(r"^(ERROR:\s*)?(\[[^\]]+\]\s*[\w-]+:\s*)?", "", message).strip()


BASE_OPTS = {"quiet": True, "no_warnings": True, "noplaylist": True, "noprogress": True}
# YouTube serves video as many small DASH fragments; downloading several in parallel
# is much faster than yt-dlp's default of one fragment at a time, especially for long videos.
CONCURRENT_FRAGMENTS = 8
PREVIEW_HEIGHTS = (2160, 1440, 1080, 720, 480, 360)


def _cleanup_partial_files(dest_dir: Path, stem: str) -> None:
    """Removes leftover fragment/metadata files from an interrupted or failed download."""
    for p in dest_dir.glob(f"{stem}.*"):
        if ".part" in p.name or p.suffix in (".ytdl", ".temp"):
            p.unlink(missing_ok=True)


def _format(kind: str, quality: str) -> str:
    if kind == "audio":
        return "ba[ext=m4a]/ba/b"
    h = "" if quality == "best" else f"[height<={quality}]"
    # Prefer H.264 so downloads play everywhere and OpenCV decodes them quickly.
    return f"bv*{h}[vcodec^=avc1]+ba[ext=m4a]/bv*{h}[ext=mp4]+ba[ext=m4a]/bv*{h}+ba/b{h}/b"


def fetch_info(url: str) -> dict:
    import yt_dlp

    with yt_dlp.YoutubeDL(BASE_OPTS) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as exc:
            raise PipelineError(_clean(exc)) from exc
    heights = {f.get("height") for f in info.get("formats") or [] if f.get("height") and f.get("vcodec") not in (None, "none")}
    return {
        "id": info.get("id"),
        "title": info.get("title") or "YouTube video",
        "channel": info.get("channel") or info.get("uploader"),
        "duration": info.get("duration") or 0,
        "thumbnail": info.get("thumbnail"),
        "is_live": bool(info.get("is_live")),
        "qualities": [h for h in PREVIEW_HEIGHTS if any(x >= h for x in heights)],
        "webpage_url": info.get("webpage_url") or url,
    }


def download_youtube(
    url: str,
    dest_dir: Path,
    on_progress: Callable[[float], None],
    stem: str = "source",
    kind: str = "video",
    quality: str = "1080",
    audio_format: str = "m4a",
) -> dict:
    import yt_dlp

    # A crashed/retried download can leave half-written fragments behind; clear them before
    # (re)starting so disk usage doesn't grow with every retry.
    _cleanup_partial_files(dest_dir, stem)

    state = {"part": 0, "parts": 1}

    def hook(event: dict) -> None:
        if event.get("status") == "downloading":
            total = event.get("total_bytes") or event.get("total_bytes_estimate")
            if total:
                fraction = min(1.0, event.get("downloaded_bytes", 0) / total)
                on_progress(min(1.0, (state["part"] + fraction) / state["parts"]))
        elif event.get("status") == "finished":
            state["part"] += 1

    opts = {**BASE_OPTS, "format": _format(kind, quality), "outtmpl": str(dest_dir / f"{stem}.%(ext)s"), "progress_hooks": [hook], "concurrent_fragment_downloads": CONCURRENT_FRAGMENTS}
    if kind == "audio":
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": audio_format, "preferredquality": "192"}]
    else:
        opts["merge_output_format"] = "mp4"

    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as exc:
            raise PipelineError(f"Could not read this YouTube video: {_clean(exc)}") from exc
        if info.get("is_live"):
            raise PipelineError("Live streams are not supported")
        if (info.get("duration") or 0) > config.MAX_SOURCE_SECONDS:
            raise PipelineError(f"Video is longer than {config.MAX_SOURCE_SECONDS // 60} minutes")
        state["parts"] = len(info.get("requested_formats") or [None])
        try:
            ydl.process_ie_result(info, download=True)
        except yt_dlp.utils.DownloadError as exc:
            _cleanup_partial_files(dest_dir, stem)
            raise PipelineError(f"Download failed: {_clean(exc)}") from exc

    files = sorted(p for p in dest_dir.glob(f"{stem}.*") if p.suffix not in {".part", ".ytdl", ".webp", ".jpg"} and not p.name.endswith(".temp"))
    if not files:
        raise PipelineError("Download finished but no media file was found")
    return {
        "path": max(files, key=lambda p: p.stat().st_size),
        "title": info.get("title") or "YouTube video",
        "channel": info.get("channel") or info.get("uploader"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration") or 0,
    }
