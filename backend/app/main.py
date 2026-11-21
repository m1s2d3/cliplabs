import json
import logging
import mimetypes
import os
import re
import shutil
import tempfile
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import features
from pydantic import ValidationError
from starlette.background import BackgroundTask

from . import config, db, jobs
from .pipeline.captions import build_groups, retime_text
from .pipeline.download import fetch_info, validate_youtube_url
from .pipeline.media import PipelineError, media_url, project_dir, remove_project_dir
from .pipeline.runner import load_words
from .schemas import MODE_OPTIONS, ClipUpdate, CreateProject

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# Some systems' mimetypes database maps .m4a to the non-standard "audio/mp4a-latm",
# which browsers refuse to play inline via <audio src="...">. Force the standard type.
mimetypes.add_type("audio/mp4", ".m4a")

MIN_CLIP_SECONDS = 3
MAX_CLIP_SECONDS = 180
OUTPUT_TYPES = {".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".webm": "video/webm", ".mkv": "video/x-matroska"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    db.mark_interrupted()
    yield


config.ensure_dirs()
app = FastAPI(title="ClipLabs API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def no_store_media(request, call_next):
    # Projects can be retried/edited in place at the same URL, so media must never be
    # cached by the browser — a stale cached response (e.g. a wrong Content-Type from
    # before a bug fix) would otherwise keep being served indefinitely.
    response = await call_next(request)
    if request.url.path.startswith("/media/"):
        response.headers["Cache-Control"] = "no-store"
    return response


app.mount("/media", StaticFiles(directory=config.MEDIA_DIR), name="media")


def _versioned(path: str | None, stamp: str) -> str | None:
    url = media_url(path)
    return f"{url}?v={re.sub(r'[^0-9]', '', stamp)}" if url else None


def _slug(text: str, fallback: str = "clip") -> str:
    return re.sub(r"[^\w]+", "-", (text or "").lower()).strip("-_")[:60] or fallback


def _safe_path(path: str | None) -> Path:
    resolved = Path(path or "").resolve()
    if not path or config.MEDIA_DIR.resolve() not in resolved.parents or not resolved.exists():
        raise HTTPException(404, "File is missing")
    return resolved


def _remove_clip_files(clip: dict) -> None:
    for key in ("video_path", "thumb_path"):
        path = Path(clip[key]).resolve() if clip.get(key) else None
        if path and config.MEDIA_DIR.resolve() in path.parents:
            path.unlink(missing_ok=True)


def serialize_clip(clip: dict) -> dict:
    return {
        "id": clip["id"],
        "project_id": clip["project_id"],
        "title": clip["title"],
        "hook": clip["hook"],
        "reason": clip["reason"],
        "score": clip["score"],
        "score_breakdown": clip["score_breakdown"],
        "description": clip["description"],
        "hashtags": clip["hashtags"] or [],
        "start": clip["start"],
        "end": clip["end"],
        "duration": round(clip["end"] - clip["start"], 2),
        "captions": clip["captions"],
        "captions_enabled": clip["captions_enabled"],
        "caption_style": clip["caption_style"],
        "crop_mode": clip["crop_mode"],
        "crop_x": clip["crop_x"],
        "aspect": clip["aspect"],
        "status": clip["status"],
        "error": clip["error"],
        "video_url": _versioned(clip["video_path"], clip["updated_at"]) if clip["status"] == "ready" else None,
        "thumb_url": _versioned(clip["thumb_path"], clip["updated_at"]),
        "updated_at": clip["updated_at"],
    }


def serialize_project(project: dict, clips: list[dict] | None = None) -> dict:
    output = project.get("output_path")
    data = {
        "id": project["id"],
        "title": project["title"],
        "mode": project["mode"],
        "source_type": project["source_type"],
        "source_url": project["source_url"],
        "channel": project["channel"],
        "thumbnail": project["thumbnail"],
        "language": project["language"],
        "status": project["status"],
        "progress": project["progress"],
        "message": project["message"],
        "error": project["error"],
        "options": project["options"],
        "duration": project["duration"],
        "width": project["width"],
        "height": project["height"],
        "cancel_requested": bool(project["cancel_requested"]),
        "output_url": media_url(output) if output and Path(output).exists() else None,
        "output_kind": Path(output).suffix.lstrip(".") if output else None,
        "output_size": project["output_size"],
        "started_at": project["started_at"],
        "finished_at": project["finished_at"],
        "created_at": project["created_at"],
        "updated_at": project["updated_at"],
    }
    if "clip_count" in project:
        data["clip_count"] = project["clip_count"]
        data["thumb_url"] = media_url(project.get("thumb_path"))
    if clips is not None:
        data["clips"] = [serialize_clip(c) for c in clips]
        source = project.get("source_path")
        data["source_media_url"] = media_url(source) if source and Path(source).exists() else None
    return data


def _get_project_or_404(project_id: str) -> dict:
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return project


def _get_clip_or_404(clip_id: str) -> dict:
    clip = db.get_clip(clip_id)
    if not clip:
        raise HTTPException(404, "Clip not found")
    return clip


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "highlight_engine": "openai" if config.OPENAI_API_KEY else "heuristic",
        "whisper_model": config.WHISPER_MODEL,
        "whisper_multilingual_model": config.WHISPER_MULTILINGUAL_MODEL,
        "indic_captions": bool(features.check("raqm")),
    }


def _validate_options(mode: str, raw: dict) -> dict:
    try:
        return MODE_OPTIONS[mode].model_validate(raw).model_dump()
    except ValidationError as exc:
        raise HTTPException(422, exc.errors(include_url=False, include_context=False)) from exc


@app.get("/api/youtube/info")
def youtube_info(url: str) -> dict:
    try:
        clean = validate_youtube_url(url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        return fetch_info(clean)
    except PipelineError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/projects")
def list_projects() -> list[dict]:
    return [serialize_project(p) for p in db.list_projects()]


@app.post("/api/projects", status_code=201)
def create_project(body: CreateProject) -> dict:
    try:
        url = validate_youtube_url(body.url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    options = _validate_options(body.mode, body.options)
    existing = db.find_active_by_source(url, body.mode)
    if existing:
        raise HTTPException(409, f"Already processing this video (project {existing['id']})")
    project = db.create_project("YouTube video", "youtube", options, source_url=url, mode=body.mode)
    jobs.submit_project(project["id"])
    return serialize_project(project, [])


@app.post("/api/projects/upload", status_code=201)
async def create_from_upload(file: UploadFile = File(...), options: str = Form("{}"), mode: str = Form("clips")) -> dict:
    if mode not in ("clips", "cut"):
        raise HTTPException(400, "Uploads support the clips and cut modes")
    try:
        raw = json.loads(options or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(422, "Options must be valid JSON") from exc
    opts = _validate_options(mode, raw if isinstance(raw, dict) else {})
    extension = Path(file.filename or "").suffix.lower()
    if extension not in config.UPLOAD_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type. Use one of: {', '.join(sorted(config.UPLOAD_EXTENSIONS))}")

    project_id = db.new_id()
    dest = project_dir(project_id) / f"source{extension}"
    limit, size = config.MAX_UPLOAD_MB * 1024 * 1024, 0
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                out.close()
                remove_project_dir(project_id)
                raise HTTPException(413, f"File is larger than {config.MAX_UPLOAD_MB} MB")
            out.write(chunk)
    if size == 0:
        remove_project_dir(project_id)
        raise HTTPException(400, "The uploaded file is empty")

    title = Path(file.filename or "").stem.strip()[:120] or "Uploaded video"
    project = db.create_project(title, "upload", opts, source_path=str(dest), project_id=project_id, mode=mode)
    jobs.submit_project(project_id)
    return serialize_project(project, [])


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    project = _get_project_or_404(project_id)
    return serialize_project(project, db.list_clips(project_id))


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    project = _get_project_or_404(project_id)
    busy = project["status"] not in db.TERMINAL_STATUSES or any(c["status"] in ("queued", "rendering") for c in db.list_clips(project_id))
    if busy:
        raise HTTPException(409, "This project is still processing")
    db.delete_project(project_id)
    remove_project_dir(project_id)


@app.post("/api/projects/{project_id}/cancel")
def cancel_project(project_id: str) -> dict:
    project = _get_project_or_404(project_id)
    if project["status"] in db.TERMINAL_STATUSES:
        raise HTTPException(409, "This project has already finished")
    db.update_project(project_id, cancel_requested=1, message="Cancelling…")
    return serialize_project(db.get_project(project_id), db.list_clips(project_id))


@app.post("/api/projects/{project_id}/retry")
def retry_project(project_id: str) -> dict:
    project = _get_project_or_404(project_id)
    if project["status"] not in ("failed", "cancelled"):
        raise HTTPException(409, "Only failed or cancelled projects can be retried")
    for clip in db.list_clips(project_id):
        _remove_clip_files(clip)
    db.delete_clips(project_id)
    if project["output_path"]:
        Path(project["output_path"]).unlink(missing_ok=True)
    db.update_project(
        project_id, status="queued", progress=0, message="Waiting in queue", error=None,
        cancel_requested=0, output_path=None, output_size=None, started_at=None, finished_at=None,
    )
    jobs.submit_project(project_id)
    return serialize_project(db.get_project(project_id), [])


@app.get("/api/projects/{project_id}/file")
def project_file(project_id: str) -> FileResponse:
    project = _get_project_or_404(project_id)
    if project["mode"] != "download" or project["status"] != "done":
        raise HTTPException(409, "The download is not ready yet")
    path = _safe_path(project["output_path"])
    return FileResponse(path, media_type=OUTPUT_TYPES.get(path.suffix, "application/octet-stream"), filename=f"{_slug(project['title'], 'download')}{path.suffix}")


@app.get("/api/projects/{project_id}/analysis")
def project_analysis(project_id: str) -> dict:
    _get_project_or_404(project_id)
    folder = project_dir(project_id)
    waveform = json.loads((folder / "waveform.json").read_text()) if (folder / "waveform.json").exists() else None
    transcript = json.loads((folder / "transcript.json").read_text()) if (folder / "transcript.json").exists() else {}
    return {
        "waveform": waveform,
        "segments": transcript.get("segments", []),
        "language": transcript.get("language"),
        "reliable": transcript.get("reliable", True),
    }


@app.get("/api/projects/{project_id}/zip")
def project_zip(project_id: str, clips: str | None = None) -> FileResponse:
    project = _get_project_or_404(project_id)
    wanted = set(clips.split(",")) if clips else None
    ready = [c for c in db.list_clips(project_id) if c["status"] == "ready" and c["video_path"] and (wanted is None or c["id"] in wanted)]
    if not ready:
        raise HTTPException(404, "No ready clips to download")
    handle = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    handle.close()
    notes = []
    # MP4s are already compressed, so storing them uncompressed keeps the ZIP fast to build.
    with zipfile.ZipFile(handle.name, "w", zipfile.ZIP_STORED) as archive:
        for number, clip in enumerate(ready, 1):
            name = f"{number:02d}-{_slug(clip['title'])}.mp4"
            archive.write(_safe_path(clip["video_path"]), name)
            notes.append(f"{name}\nTitle: {clip['title']}\nDescription: {clip['description'] or ''}\nHashtags: {' '.join(clip['hashtags'] or [])}\n")
        archive.writestr("captions.txt", "\n".join(notes))
    return FileResponse(handle.name, media_type="application/zip", filename=f"{_slug(project['title'], 'project')}-clips.zip", background=BackgroundTask(os.unlink, handle.name))


@app.patch("/api/clips/{clip_id}")
def update_clip(clip_id: str, body: ClipUpdate) -> dict:
    clip = _get_clip_or_404(clip_id)
    project = _get_project_or_404(clip["project_id"])
    if clip["status"] in ("queued", "rendering") or project["status"] not in db.TERMINAL_STATUSES:
        raise HTTPException(409, "This clip is still rendering")

    changes: dict = {}
    rerender = False
    if body.title is not None and body.title.strip():
        changes["title"] = body.title.strip()

    start = clip["start"] if body.start is None else round(body.start, 3)
    end = clip["end"] if body.end is None else round(body.end, 3)
    if (start, end) != (clip["start"], clip["end"]):
        if not (0 <= start < end <= (project["duration"] or 0) + 0.01):
            raise HTTPException(400, "Start and end must be inside the source video")
        if not MIN_CLIP_SECONDS <= end - start <= MAX_CLIP_SECONDS:
            raise HTTPException(400, f"Clips must be {MIN_CLIP_SECONDS}–{MAX_CLIP_SECONDS} seconds long")
        changes.update(start=start, end=end, captions=build_groups(load_words(project["id"]), start, end))
        rerender = True
    elif body.captions is not None:
        groups = []
        for line in sorted(body.captions, key=lambda c: c.start):
            line_start, line_end = max(line.start, clip["start"]), min(line.end, clip["end"])
            words = retime_text(line_start, line_end, line.text.strip())
            if words:
                groups.append({"start": words[0]["start"], "end": words[-1]["end"], "words": words})
        changes["captions"] = groups
        rerender = True

    if body.captions_enabled is not None and body.captions_enabled != clip["captions_enabled"]:
        changes["captions_enabled"] = body.captions_enabled
        rerender = True

    for field in ("caption_style", "crop_mode", "aspect"):
        value = getattr(body, field)
        if value is not None and value != clip[field]:
            changes[field] = value
            rerender = True
    if body.crop_x is not None and body.crop_x != clip["crop_x"]:
        changes["crop_x"] = body.crop_x
        changes.setdefault("crop_mode", "manual")
        rerender = True

    if rerender:
        changes["status"] = "queued"
    if changes:
        db.update_clip(clip_id, **changes)
    if rerender:
        jobs.submit_render(clip_id)
    return serialize_clip(db.get_clip(clip_id))


@app.get("/api/clips/{clip_id}/download")
def download_clip(clip_id: str) -> FileResponse:
    clip = _get_clip_or_404(clip_id)
    if clip["status"] != "ready" or not clip["video_path"]:
        raise HTTPException(409, "Clip is not ready yet")
    return FileResponse(_safe_path(clip["video_path"]), media_type="video/mp4", filename=f"{_slug(clip['title'])}.mp4")


@app.delete("/api/clips/{clip_id}", status_code=204)
def delete_clip(clip_id: str) -> None:
    clip = _get_clip_or_404(clip_id)
    if clip["status"] in ("queued", "rendering"):
        raise HTTPException(409, "This clip is still rendering")
    _remove_clip_files(clip)
    db.delete_clip(clip_id)


@app.post("/api/clips/{clip_id}/duplicate", status_code=201)
def duplicate_clip(clip_id: str) -> dict:
    clip = _get_clip_or_404(clip_id)
    if clip["status"] != "ready":
        raise HTTPException(409, "Only ready clips can be duplicated")
    copied = ("idx", "hook", "reason", "score", "start", "end", "captions", "captions_enabled", "score_breakdown",
              "description", "hashtags", "caption_style", "crop_mode", "crop_x", "aspect")
    new = db.insert_clip(clip["project_id"], {**{k: clip[k] for k in copied}, "title": f"{clip['title']} (copy)"[:120], "status": "ready"})
    paths = {}
    for key, suffix in (("video_path", ".mp4"), ("thumb_path", ".jpg")):
        if clip[key] and Path(clip[key]).exists():
            target = Path(clip[key]).with_name(f"{new['id']}{suffix}")
            shutil.copyfile(clip[key], target)
            paths[key] = str(target)
    db.update_clip(new["id"], **paths)
    return serialize_clip(db.get_clip(new["id"]))
