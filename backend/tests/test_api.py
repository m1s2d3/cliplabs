import json

from app import db


def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["highlight_engine"] in {"openai", "heuristic"}


def test_create_project_from_youtube_url(client):
    response = client.post("/api/projects", json={"url": "https://youtu.be/abc123", "options": {"clip_count": 3}})
    assert response.status_code == 201
    project = response.json()
    assert project["status"] == "queued"
    assert client.submitted["projects"] == [project["id"]]
    assert client.get("/api/projects").json()[0]["id"] == project["id"]


def test_create_download_with_from_to_range(client):
    response = client.post("/api/projects", json={
        "url": "https://youtu.be/abc123",
        "mode": "download",
        "options": {"range_start": 315, "range_end": 900},
    })
    assert response.status_code == 201
    assert response.json()["options"]["range_start"] == 315
    assert response.json()["options"]["range_end"] == 900


def test_rejects_reversed_download_range(client):
    response = client.post("/api/projects", json={
        "url": "https://youtu.be/abc123",
        "mode": "download",
        "options": {"range_start": 900, "range_end": 315},
    })
    assert response.status_code == 422


def test_create_project_preserves_layout_and_custom_frame_options(client):
    response = client.post("/api/projects", json={
        "url": "https://youtu.be/abc123",
        "options": {
            "crop_mode": "side_by_side",
            "pip_position": "top_left",
            "pip_shape": "square",
            "aspect": "custom",
            "output_width": 1440,
            "output_height": 900,
            "facecam_area": [0.05, 0.1, 0.3, 0.4],
            "gameplay_area": [0.55, 0.2, 0.4, 0.7],
        },
    })
    assert response.status_code == 201
    options = response.json()["options"]
    assert options["crop_mode"] == "side_by_side"
    assert options["pip_position"] == "top_left"
    assert (options["output_width"], options["output_height"]) == (1440, 900)
    assert options["facecam_area"] == [0.05, 0.1, 0.3, 0.4]
    assert options["gameplay_area"] == [0.55, 0.2, 0.4, 0.7]


def test_create_clips_project_preserves_youtube_download_range(client):
    response = client.post("/api/projects", json={
        "url": "https://youtu.be/abc123",
        "options": {"range_start": 315, "range_end": 375},
    })
    assert response.status_code == 201
    options = response.json()["options"]
    assert options["range_start"] == 315
    assert options["range_end"] == 375


def test_rejects_non_youtube_url(client):
    response = client.post("/api/projects", json={"url": "https://example.com/video.mp4"})
    assert response.status_code == 400
    assert client.submitted["projects"] == []


def test_youtube_frame_rejects_non_youtube_url_and_invalid_time(client):
    bad_url = client.get("/api/youtube/frame", params={"url": "https://example.com/video", "time": 1})
    bad_time = client.get("/api/youtube/frame", params={"url": "https://youtu.be/abc123", "time": 21601})
    assert bad_url.status_code == 400
    assert bad_time.status_code == 400


def test_rejects_bad_options(client):
    response = client.post("/api/projects", json={"url": "https://youtu.be/abc", "options": {"clip_count": 50}})
    assert response.status_code == 422


def test_custom_frame_requires_even_dimensions(client):
    missing = client.post("/api/projects", json={"url": "https://youtu.be/abc", "options": {"aspect": "custom"}})
    odd = client.post("/api/projects", json={"url": "https://youtu.be/abc", "options": {"aspect": "custom", "output_width": 1081, "output_height": 1920}})
    assert missing.status_code == 422
    assert odd.status_code == 422


def test_area_selection_must_fit_source_frame(client):
    response = client.post("/api/projects", json={
        "url": "https://youtu.be/abc123",
        "options": {"facecam_area": [0.8, 0.7, 0.4, 0.4]},
    })
    assert response.status_code == 422


def test_upload_validates_extension_and_saves_file(client):
    bad = client.post("/api/projects/upload", files={"file": ("notes.txt", b"hello", "text/plain")})
    assert bad.status_code == 400
    good = client.post(
        "/api/projects/upload",
        files={"file": ("../../My Talk.mp4", b"fake-bytes", "video/mp4")},
        data={"options": json.dumps({"clip_count": 2, "min_length": 15, "max_length": 30})},
    )
    assert good.status_code == 201
    project = db.get_project(good.json()["id"])
    assert project["title"] == "My Talk"
    assert project["source_path"].endswith("source.mp4")
    assert project["options"]["clip_count"] == 2


def test_unknown_project_returns_404(client):
    assert client.get("/api/projects/missing").status_code == 404


def _ready_clip() -> dict:
    project = db.create_project("Talk", "upload", {"clip_count": 1, "min_length": 10, "max_length": 30, "captions": True})
    db.update_project(project["id"], status="done", duration=120.0, width=1920, height=1080)
    clip = db.insert_clip(project["id"], {"idx": 0, "title": "Title", "score": 70, "start": 10.0, "end": 30.0, "captions": [], "hashtags": ["#a"]})
    db.update_clip(clip["id"], status="ready")
    return clip


def test_edit_clip_trim_queues_render(client):
    clip = _ready_clip()
    response = client.patch(f"/api/clips/{clip['id']}", json={"start": 12, "end": 40, "title": "New title"})
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "New title"
    assert (body["start"], body["end"], body["status"]) == (12, 40, "queued")
    assert client.submitted["renders"] == [clip["id"]]


def test_edit_clip_rejects_invalid_range(client):
    clip = _ready_clip()
    assert client.patch(f"/api/clips/{clip['id']}", json={"start": 50, "end": 51}).status_code == 400
    assert client.patch(f"/api/clips/{clip['id']}", json={"start": 100, "end": 500}).status_code == 400


def test_edit_captions_retimes_words(client):
    clip = _ready_clip()
    response = client.patch(f"/api/clips/{clip['id']}", json={"captions": [{"start": 11, "end": 13, "text": "Hello world"}]})
    words = response.json()["captions"][0]["words"]
    assert [w["word"] for w in words] == ["Hello", "world"]


def test_title_only_edit_does_not_rerender(client):
    clip = _ready_clip()
    client.patch(f"/api/clips/{clip['id']}", json={"title": "Only title"})
    assert client.submitted["renders"] == []


def test_cannot_delete_processing_project(client):
    project = client.post("/api/projects", json={"url": "https://youtu.be/abc"}).json()
    assert client.delete(f"/api/projects/{project['id']}").status_code == 409
    db.update_project(project["id"], status="failed")
    assert client.delete(f"/api/projects/{project['id']}").status_code == 204
    assert client.get(f"/api/projects/{project['id']}").status_code == 404


def test_modes_validate_their_own_options(client):
    cut = client.post("/api/projects", json={"url": "https://youtu.be/abc", "mode": "cut", "options": {"start": 30, "end": 45, "aspect": "9:16"}})
    assert cut.status_code == 201 and cut.json()["mode"] == "cut"
    bad_cut = client.post("/api/projects", json={"url": "https://youtu.be/abc", "mode": "cut", "options": {"start": 30, "end": 30.5}})
    assert bad_cut.status_code == 422
    dl = client.post("/api/projects", json={"url": "https://youtu.be/abc", "mode": "download", "options": {"kind": "audio", "audio_format": "mp3"}})
    assert dl.status_code == 201 and dl.json()["options"]["audio_format"] == "mp3"
    assert client.post("/api/projects", json={"url": "https://youtu.be/abc", "mode": "steal"}).status_code == 422


def test_upload_rejects_download_mode(client):
    response = client.post("/api/projects/upload", files={"file": ("a.mp4", b"x", "video/mp4")}, data={"mode": "download"})
    assert response.status_code == 400


def test_youtube_info_endpoint(client, monkeypatch):
    import app.main as main

    monkeypatch.setattr(main, "fetch_info", lambda url: {"title": "T", "duration": 90, "qualities": [1080, 720]})
    assert client.get("/api/youtube/info", params={"url": "https://youtu.be/abc"}).json()["title"] == "T"
    assert client.get("/api/youtube/info", params={"url": "https://vimeo.com/1"}).status_code == 400


def test_cancel_and_retry(client):
    project = client.post("/api/projects", json={"url": "https://youtu.be/abc"}).json()
    assert client.post(f"/api/projects/{project['id']}/retry").status_code == 409
    cancelled = client.post(f"/api/projects/{project['id']}/cancel").json()
    assert cancelled["cancel_requested"] is True
    db.update_project(project["id"], status="cancelled")
    assert client.post(f"/api/projects/{project['id']}/cancel").status_code == 409
    db.update_project(project["id"], options={**project["options"], "range_start": 0, "range_end": 60})
    retried = client.post(f"/api/projects/{project['id']}/retry", json={"content_type": "music"}).json()
    assert retried["status"] == "queued" and retried["cancel_requested"] is False
    assert retried["options"]["content_type"] == "music"
    assert retried["options"]["range_end"] == 60
    assert client.submitted["projects"] == [project["id"], project["id"]]


def _with_files(clip: dict) -> dict:
    from app.pipeline.media import project_dir

    folder = project_dir(clip["project_id"]) / "clips"
    folder.mkdir(parents=True, exist_ok=True)
    video, thumb = folder / f"{clip['id']}.mp4", folder / f"{clip['id']}.jpg"
    video.write_bytes(b"video-bytes")
    thumb.write_bytes(b"jpg")
    db.update_clip(clip["id"], video_path=str(video), thumb_path=str(thumb))
    return db.get_clip(clip["id"])


def test_zip_contains_ready_clips_and_notes(client):
    import io
    import zipfile

    clip = _with_files(_ready_clip())
    response = client.get(f"/api/projects/{clip['project_id']}/zip")
    assert response.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(response.content)).namelist()
    assert names == ["01-title.mp4", "captions.txt"]
    assert client.get(f"/api/projects/{clip['project_id']}/zip", params={"clips": "nope"}).status_code == 404


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert copy["title"] == "Title (copy)" and copy["status"] == "ready" and copy["video_url"]
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)


def test_duplicate_and_delete_clip(client):
    clip = _with_files(_ready_clip())
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.8, crop_zoom=0.75, crop_zoom2=0.65, hook_enabled=True)
    copy = client.post(f"/api/clips/{clip['id']}/duplicate").json()
    assert (copy["crop_mode"], copy["crop_x2"], copy["crop_zoom2"], copy["hook_enabled"]) == ("split", 0.8, 0.65, True)
    assert client.delete(f"/api/clips/{copy['id']}").status_code == 204
    assert len(client.get(f"/api/projects/{clip['project_id']}").json()["clips"]) == 1


def test_style_crop_and_aspect_edits_rerender(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"caption_style": "karaoke", "crop_x": 0.2, "aspect": "1:1"}).json()
    assert (body["caption_style"], body["crop_mode"], body["crop_x"], body["aspect"]) == ("karaoke", "manual", 0.2, "1:1")
    assert client.submitted["renders"] == [clip["id"]]


def test_style_hook_edit_rerenders(client):
    clip = _ready_clip()
    body = client.patch(f"/api/clips/{clip['id']}", json={"hook_enabled": True, "hook": "Can you survive this?", "hook_duration": 6}).json()
    assert (body["hook_enabled"], body["hook"], body["hook_duration"]) == (True, "Can you survive this?", 6)
    assert client.submitted["renders"] == [clip["id"]]


def test_migration_adds_columns_to_v1_database(tmp_path, monkeypatch):
    import sqlite3

    from app import config

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.executescript(db.SCHEMA)
        conn.execute("INSERT INTO projects (id, title, source_type, status, options, created_at, updated_at) VALUES ('p', 'Old', 'upload', 'done', '{}', 'x', 'x')")
    db.init_db()
    assert db.get_project("p")["mode"] == "clips"


def test_apply_frame_to_other_ready_clips(client):
    source = _ready_clip()
    other = db.insert_clip(source["project_id"], {"idx": 1, "title": "Other", "score": 60, "start": 40.0, "end": 60.0, "captions": []})
    db.update_clip(other["id"], status="ready")

    db.update_project(other["project_id"], status="done")
    body = client.post(
        f"/api/projects/{source['project_id']}/apply-frame",
        params={"source_clip_id": source["id"]},
        json={"aspect": "9:16", "crop_mode": "split", "crop_x": 0.2, "crop_x2": 0.7, "crop_zoom": 0.8, "crop_zoom2": 0.6},
    )
    assert body.status_code == 200
    assert body.json()["count"] == 1
    updated = body.json()["clips"][0]
    assert updated["id"] == other["id"] and updated["status"] == "queued"
    assert (updated["crop_mode"], updated["crop_x2"], updated["crop_zoom2"]) == ("split", 0.7, 0.6)


def test_clip_api_preserves_full_layout_settings(client):
    clip = _ready_clip()
    db.update_clip(clip["id"], crop_mode="split", crop_x=0.2, crop_x2=0.7, crop_zoom=0.8, crop_zoom2=0.6)
    body = client.get(f"/api/projects/{clip['project_id']}").json()["clips"][0]
    assert (body["crop_mode"], body["crop_x"], body["crop_x2"], body["crop_zoom"], body["crop_zoom2"]) == ("split", 0.2, 0.7, 0.8, 0.6)
