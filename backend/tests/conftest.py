import os
import sys
from collections import defaultdict
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app import config, db, jobs, main

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    submitted = {"projects": [], "renders": []}
    monkeypatch.setattr(jobs, "submit_project", submitted["projects"].append)
    monkeypatch.setattr(jobs, "submit_render", submitted["renders"].append)
    # Keeps project-creation tests network-free; tests that care about metadata
    # (e.g. test_youtube_info_endpoint) monkeypatch main.fetch_info themselves.
    monkeypatch.setattr(main, "fetch_info", lambda url: {"is_live": False})
    # TestClient reuses the same fake client IP across tests, so the rate limiter's
    # bucket must be reset per test or earlier tests would exhaust later ones' quota.
    monkeypatch.setattr(main, "_rate_hits", defaultdict(list))
    config.ensure_dirs()
    db.init_db()

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        test_client.submitted = submitted
        yield test_client


os.environ.setdefault("OPENAI_API_KEY", "")
