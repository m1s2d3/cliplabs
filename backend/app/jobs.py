import logging
from concurrent.futures import ThreadPoolExecutor

from .pipeline import runner

log = logging.getLogger(__name__)

# One worker each: transcription and rendering are CPU-bound, so parallel jobs only slow each other down.
_projects = ThreadPoolExecutor(max_workers=1, thread_name_prefix="project")
_renders = ThreadPoolExecutor(max_workers=1, thread_name_prefix="render")


def _safe(fn, *args) -> None:
    try:
        fn(*args)
    except Exception:  # noqa: BLE001
        log.exception("Background job %s failed", fn.__name__)


def submit_project(project_id: str) -> None:
    _projects.submit(_safe, runner.run_project, project_id)


def submit_render(clip_id: str) -> None:
    _renders.submit(_safe, runner.render_clip_job, clip_id)
