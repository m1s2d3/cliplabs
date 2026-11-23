import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from . import config

_lock = threading.Lock()

TERMINAL_STATUSES = {"done", "failed", "cancelled"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    source_path TEXT,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    message TEXT,
    error TEXT,
    options TEXT NOT NULL,
    duration REAL,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    hook TEXT,
    reason TEXT,
    score REAL NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    captions TEXT NOT NULL,
    captions_enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    error TEXT,
    video_path TEXT,
    thumb_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
"""

# Columns added after v1; applied with ALTER TABLE so existing databases keep their data.
MIGRATIONS = {
    "projects": {
        "mode": "TEXT NOT NULL DEFAULT 'clips'",
        "channel": "TEXT",
        "thumbnail": "TEXT",
        "language": "TEXT",
        "cancel_requested": "INTEGER NOT NULL DEFAULT 0",
        "started_at": "TEXT",
        "finished_at": "TEXT",
        "output_path": "TEXT",
        "output_size": "INTEGER",
    },
    "clips": {
        "score_breakdown": "TEXT",
        "description": "TEXT",
        "hashtags": "TEXT",
        "caption_style": "TEXT NOT NULL DEFAULT 'classic'",
        "crop_mode": "TEXT NOT NULL DEFAULT 'center'",
        "crop_x": "REAL",
        "crop_x2": "REAL",
        "crop_y": "REAL",
        "crop_y2": "REAL",
        "crop_zoom": "REAL",
        "crop_zoom2": "REAL",
        "aspect": "TEXT NOT NULL DEFAULT '9:16'",
        "hook_enabled": "INTEGER NOT NULL DEFAULT 0",
        "hook_duration": "REAL NOT NULL DEFAULT 8.0",
        "pip_position": "TEXT NOT NULL DEFAULT 'bottom_right'",
        "pip_shape": "TEXT NOT NULL DEFAULT 'circle'",
        "rating": "INTEGER",
    },
}

PROJECT_JSON_FIELDS = {"options"}
CLIP_JSON_FIELDS = {"captions", "score_breakdown", "hashtags"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    config.ensure_dirs()
    with _lock, _connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        for table, columns in MIGRATIONS.items():
            existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def _decode(row: sqlite3.Row | None, json_fields: set[str]) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for field in json_fields:
        if data.get(field) is not None:
            data[field] = json.loads(data[field])
    if "captions_enabled" in data:
        data["captions_enabled"] = bool(data["captions_enabled"])
    if "hook_enabled" in data:
        data["hook_enabled"] = bool(data["hook_enabled"])
    return data


def _encode(fields: dict[str, Any], json_fields: set[str]) -> dict[str, Any]:
    return {k: json.dumps(v) if k in json_fields else v for k, v in fields.items()}


def _update(table: str, row_id: str, fields: dict[str, Any], json_fields: set[str]) -> None:
    fields = _encode({**fields, "updated_at": now()}, json_fields)
    assignments = ", ".join(f"{key} = ?" for key in fields)
    with _lock, _connect() as conn:
        conn.execute(f"UPDATE {table} SET {assignments} WHERE id = ?", [*fields.values(), row_id])


def create_project(title: str, source_type: str, options: dict, source_url: str | None = None, source_path: str | None = None, project_id: str | None = None, mode: str = "clips") -> dict:
    project_id = project_id or new_id()
    stamp = now()
    with _lock, _connect() as conn:
        conn.execute(
            "INSERT INTO projects (id, title, source_type, source_url, source_path, status, progress, message, options, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, 'Waiting in queue', ?, ?, ?, ?)",
            (project_id, title, source_type, source_url, source_path, json.dumps(options), mode, stamp, stamp),
        )
    return get_project(project_id)


def update_project(project_id: str, **fields: Any) -> None:
    _update("projects", project_id, fields, PROJECT_JSON_FIELDS)


def get_project(project_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _decode(row, PROJECT_JSON_FIELDS)


def list_projects() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT p.*, COUNT(c.id) AS clip_count,
                      (SELECT thumb_path FROM clips WHERE project_id = p.id AND thumb_path IS NOT NULL ORDER BY score DESC LIMIT 1) AS thumb_path
               FROM projects p LEFT JOIN clips c ON c.project_id = p.id
               GROUP BY p.id ORDER BY p.created_at DESC"""
        ).fetchall()
    return [_decode(row, PROJECT_JSON_FIELDS) for row in rows]


def find_active_by_source(source_url: str, mode: str) -> dict | None:
    """Finds a not-yet-finished project for the same URL+mode, to avoid redundant re-downloads."""
    placeholders = ",".join("?" * len(TERMINAL_STATUSES))
    with _connect() as conn:
        row = conn.execute(
            f"SELECT * FROM projects WHERE source_url = ? AND mode = ? AND status NOT IN ({placeholders}) "
            "ORDER BY created_at DESC LIMIT 1",
            (source_url, mode, *TERMINAL_STATUSES),
        ).fetchone()
    return _decode(row, PROJECT_JSON_FIELDS) if row else None


def delete_project(project_id: str) -> None:
    with _lock, _connect() as conn:
        conn.execute("DELETE FROM clips WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))


def mark_interrupted() -> None:
    message = "Interrupted by a server restart. Please try again."
    with _lock, _connect() as conn:
        conn.execute("UPDATE projects SET status = 'failed', error = ?, updated_at = ? WHERE status NOT IN ('done', 'failed', 'cancelled')", (message, now()))
        conn.execute("UPDATE clips SET status = 'failed', error = ?, updated_at = ? WHERE status NOT IN ('ready', 'failed')", (message, now()))


def is_cancel_requested(project_id: str) -> bool:
    with _connect() as conn:
        row = conn.execute("SELECT cancel_requested FROM projects WHERE id = ?", (project_id,)).fetchone()
    return bool(row and row[0])


def insert_clip(project_id: str, fields: dict) -> dict:
    stamp = now()
    data = {
        "hook": None, "reason": None, "captions_enabled": True, "caption_style": "classic", "crop_mode": "center", "aspect": "9:16", "hook_enabled": False, "hook_duration": 8.0, "pip_position": "bottom_right", "pip_shape": "circle",
        **fields,
        "id": new_id(), "project_id": project_id, "status": fields.get("status", "queued"), "created_at": stamp, "updated_at": stamp,
    }
    data["captions_enabled"] = int(data["captions_enabled"])
    data = _encode(data, CLIP_JSON_FIELDS)
    with _lock, _connect() as conn:
        conn.execute(f"INSERT INTO clips ({', '.join(data)}) VALUES ({', '.join('?' for _ in data)})", list(data.values()))
    return get_clip(data["id"])


def delete_clip(clip_id: str) -> None:
    with _lock, _connect() as conn:
        conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))


def delete_clips(project_id: str) -> None:
    with _lock, _connect() as conn:
        conn.execute("DELETE FROM clips WHERE project_id = ?", (project_id,))


def update_clip(clip_id: str, **fields: Any) -> None:
    if "captions_enabled" in fields:
        fields["captions_enabled"] = int(fields["captions_enabled"])
    if "hook_enabled" in fields:
        fields["hook_enabled"] = int(fields["hook_enabled"])
    _update("clips", clip_id, fields, CLIP_JSON_FIELDS)


def get_clip(clip_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
    return _decode(row, CLIP_JSON_FIELDS)


def list_clips(project_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM clips WHERE project_id = ? ORDER BY score DESC, idx", (project_id,)).fetchall()
    return [_decode(row, CLIP_JSON_FIELDS) for row in rows]
