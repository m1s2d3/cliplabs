# ClipLabs

ClipLabs is a browser-based video workflow tool. It turns YouTube videos or uploaded video files into short, reframed clips; makes a manually selected cut; or downloads YouTube video/audio. The frontend is a React single-page application. A FastAPI backend validates requests, stores project state, runs media jobs, and serves generated assets.

This document is both an operator guide and an implementation blueprint. It describes the behavior currently implemented in this repository; it is not a promise that every visible hint is enforced by the server.

## Product Scope

The app has three primary workflows:

1. **Create clips:** Find engaging moments from a YouTube video or uploaded video, then render the selected moments as individually editable clips.
2. **Manual cut:** Select one time interval from a YouTube or uploaded source and render it as a single output clip.
3. **Downloader:** Download a YouTube video or audio track, optionally limited to a source time range.

The project workspace provides progress, cancellation, retry, clip editing, preview, export, and project deletion. Processing is asynchronous: the API returns a project immediately and the browser polls for updated state.

## Technology

- Frontend: React 19, React DOM 19, Vite 7, JavaScript/JSX; hash-based routes; CSS in `src/styles.css`.
- Backend: Python 3.12, FastAPI, Pydantic 2, Uvicorn.
- Persistence: SQLite with startup migrations; media files on local/persistent disk.
- Media: yt-dlp for YouTube, FFmpeg/ffprobe for download/post-processing and encode/decode, OpenCV for scene/frame work and face detection, NumPy for signal/media arrays, Pillow for caption drawing.
- Speech: faster-whisper with word timestamps and VAD.
- Optional AI ranking: OpenAI API when `OPENAI_API_KEY` is configured; heuristic ranking remains the fallback.
- PWA: web manifest and service worker. It is installed/registered in production; the service worker does not cache API or media paths.

## Repository Map

```text
src/
  App.jsx                  App shell, hash routes, queue, health and online state
  api.js                   API client, uploads, base URL and media URL helpers
  constants.js             Shared status labels and UI constants
  utils.js                 Navigation and common frontend utilities
  styles.css               App theme, layout, component and responsive styles
  pwa.js                   Service-worker registration and online state
  pages/
    Landing.jsx            Create and Downloader entry experience
    Projects.jsx           Search/filter/list projects
    ProjectDetail.jsx      Progress, errors, project actions and clip workspace
  components/
    CreatePanel.jsx        YouTube/upload input and workflow options
    ProgressCard.jsx       Job progress and cancellation UI
    SourceTimeline.jsx     Source media timeline/analysis view
    Waveform.jsx           Waveform visualization
    ClipCard.jsx           Clip list item and quick actions
    ClipEditor.jsx         Trim, crop/layout, caption and hook editor
    CaptionStylePicker.jsx Caption style selection
    PlayerModal.jsx        Video playback/preview modal
    DownloadResult.jsx    Completed source download result
    ConfirmModal.jsx       Destructive-action confirmation
backend/
  app/
    main.py                FastAPI routes, serialization, validation and exports
    config.py              Environment/config/data paths
    db.py                  SQLite schema, migrations and CRUD
    jobs.py                Background project/render executors
    schemas.py             Pydantic request models and validation rules
    pipeline/
      download.py          YouTube URL validation, metadata, range downloads/frame extraction
      media.py             FFmpeg/ffprobe, audio, waveform and scene helpers
      transcribe.py        faster-whisper setup and transcription
      highlights.py        Talking, gaming and music candidate scoring/selection
      captions.py          Transcript grouping and caption timing helpers
      reframe.py           Crop/layout and face-aware framing logic
      render.py            Clip rendering, caption/hook overlays and encoding
      runner.py            End-to-end job orchestration and progress
  tests/
    test_api.py            API/schema/lifecycle/export tests
    test_pipeline.py       Pipeline helper and rendering-planning tests
  Dockerfile               Containerized backend runtime
  railway.toml             Railway deployment configuration
public/
  manifest.webmanifest     PWA metadata
  sw.js                    Production service worker template
  icons/                   PWA icons
```

## Navigation And Main User Journeys

Routes use the URL hash and are parsed in `src/App.jsx`:

- `#/` — Create clips.
- `#/download` — Downloader, reusing the landing page with download mode selected.
- `#/projects` — Project library.
- `#/projects/<32-character-hex-id>` — Project progress, results and editing.

### Create Clips

1. The user chooses a YouTube URL or uploads a local video. The UI can request YouTube metadata, show the title/thumbnail/duration, and preview source frames. Upload mode supports clips and manual cut, not download mode.
2. For YouTube, the user can choose a **From/To** interval. This is passed to yt-dlp as a range download, so a selected segment can be downloaded rather than fetching the whole long source. For uploaded files, the file is uploaded in full; the range limits clip analysis rather than reducing upload size.
3. The user chooses clip count, length, content type, language, output shape/resolution/frame rate, composition, and any source areas/layout-specific framing options.
4. The frontend posts a project request. The backend validates it, inserts a queued project, submits a background job, and returns the project. The frontend opens its project detail page.
5. The detail page polls project state. The backend downloads/prepares the source, analyzes audio/transcript/scenes, selects candidates, creates clip records, and renders each clip.
6. Ready clips can be watched, edited, individually downloaded, or packaged as a ZIP.

### Downloader

1. Paste a YouTube URL and load its metadata.
2. Choose video or audio. Video supports quality selection; audio supports M4A or MP3.
3. Optionally select a From/To range. The backend asks yt-dlp to download only that interval.
4. A download project is queued and its progress is polled like other jobs.
5. When complete, the result view previews/links the output file for download.

This workflow accepts YouTube URLs only. The backend rejects live streams.

### Manual Cut

1. Select a YouTube URL or upload a video.
2. Set start and end times and choose output shape and render options.
3. The backend makes one clip record for that interval and renders it.

Create Clips and Manual Cut both expose an **Add captions** toggle and the same caption style picker. Captions default to off. When enabled for a cut, the backend transcribes only the selected cut interval and offsets transcript timing back to the source timeline.

### Project Library

The Projects page lists projects, supports text search and status/type filters, and links to detail pages. Active jobs are surfaced in the app-wide queue/sidebar. Project lists and progress refresh periodically (about every three seconds while visible/online). Terminal projects can be deleted after confirmation.

### Project Detail And Clip Editing

For in-progress projects, users see the job status/progress/message and can request cancellation. Clip projects show the source and generated clip list. The editor supports the current clip's time bounds, title, caption text/enabled state/style, output aspect, crop/layout mode, independent crop positions/zoom where the selected layout uses multiple frames, PiP position/shape, and optional opening hook. It can apply frame settings to other ready clips. Render-affecting changes queue a re-render; metadata-only edits do not need a video render.

On failed/cancelled jobs, **Try again** retries the existing project. If a clips job failed with the no-speech error, **Retry as Music** is also shown. This changes only `content_type` to `music`, preserving the source, selected range, and the rest of the options. It is an explicit user action; the app does not automatically retry.

### Export

- Download a ready clip from the clip endpoint.
- Download a project ZIP containing ready clips plus a text metadata/captions file. The API can limit the ZIP to supplied clip IDs.
- Download completed Downloader-mode output from the project file endpoint.

## Clip And Render Options

The backend Pydantic models in `backend/app/schemas.py` are authoritative for accepted API values. The Create form can set a subset and sometimes sends explicit values that differ from schema defaults.

### Clips (`mode: "clips"`)

| Option | Accepted values / limits | Backend default | Notes |
|---|---|---|---|
| `clip_count` | 1–10 | 5 | Number of highlight clips to request. |
| `min_length` | 5–170 seconds | 20 | Must be at least 5 seconds shorter than `max_length`. |
| `max_length` | 10–180 seconds | 60 | Create UI length presets include Auto 20–60, Short 10–30, Medium 30–60, Long 60–90. |
| `content_type` | `talking`, `music`, `gaming` | `talking` | Gaming uses different heuristic weights; music uses music-oriented candidate selection and bypasses the no-speech guard. |
| `language` | `auto`, `en`, `hi`, `pa`, `ur`, `bn`, `ta`, `te`, `mr`, `gu`, `es`, `fr`, `de`, `pt`, `ar` | `auto` | `auto` and English use the configured base model; other languages use the multilingual model. |
| `captions` | boolean | `false` | Create Clips exposes an Add captions toggle; captions can also be enabled later in the clip editor. |
| `caption_style` | `classic`, `highlight`, `karaoke`, `minimal`, `bold` | `classic` | Used when captions are rendered. |
| `crop_mode` | `auto`, `center`, `left`, `right`, `manual`, `split`, `split_flip`, `split3`, `pip`, `blur_fill`, `side_by_side` | `auto` | Frontend presents friendly layout labels and sends the corresponding mode. |
| `pip_position` | `top_left`, `top_right`, `bottom_left`, `bottom_right` | `bottom_right` | For picture-in-picture composition. |
| `pip_shape` | `circle`, `square` | `circle` | The UI also includes independent frame shape controls for applicable selections. |
| `find_facecam` | boolean | `true` | Controls automatic framing behavior. |
| `facecam_area`, `gameplay_area` | optional normalized `[x,y,width,height]` rectangles within 0..1 | `null` | Each rectangle must have positive dimensions and fit inside the source frame. |
| `aspect` | `9:16`, `1:1`, `16:9`, `custom` | `9:16` | Custom requires even `output_width` and `output_height`, each 144–4320. |
| `output_resolution` | 144–4320 | 1080 | UI commonly labels this in output resolution/pixels. |
| `frame_rate` | 24, 30, 60 | 30 | Output frame rate. |
| `range_start`, `range_end` | optional nonnegative/positive seconds | `null` | For YouTube source downloads the selected interval is downloaded. For uploaded sources it restricts analysis. |

The UI's framing default may be Fill screen/center while the schema default is `auto`; the frontend sends the chosen mode. Do not infer the effective UI default from the Pydantic default alone.

### Manual Cut (`mode: "cut"`)

- `start >= 0`, `end > 0`; duration must be from 1 second to 10 minutes.
- `aspect`: `original`, `9:16`, `1:1`, `16:9`, or `custom`; custom dimensions follow the even-pixel 144–4320 rule.
- The UI exposes an Add captions toggle and caption style picker. Captions default to off; when enabled, only the cut range is transcribed and word timestamps are offset to source time.
- One output clip is generated.

### Download (`mode: "download"`)

- `kind`: `video` or `audio` (default `video`).
- `quality`: `best`, `2160`, `1440`, `1080`, `720`, `480`, `360` (default `1080`). The UI derives available qualities from metadata, with a fallback list.
- `audio_format`: `m4a` or `mp3` (default `m4a`).
- Optional `range_start`/`range_end`; if both are provided, end must be after start. The downloader validates bounds against source duration and maximum source duration.

## Processing Architecture

### Request And Job Lifecycle

1. FastAPI validates the URL and mode-specific options with Pydantic.
2. SQLite stores a project with a UUID-hex ID and `queued` status.
3. `backend/app/jobs.py` submits work to a single-worker project executor. Re-render jobs use a separate single-worker executor. The one-worker design avoids concurrent CPU-heavy transcription/render tasks competing with one another within each queue.
4. `runner.py` updates project status, progress, and message. The UI polls the project endpoints and renders the latest state.
5. Completion sets `done` and 100%; errors set `failed` with a user-facing error; cancellation is cooperative and results in `cancelled`.

Project statuses: `queued`, `downloading`, `transcribing`, `analyzing`, `rendering`, `done`, `failed`, `cancelled`. Clip statuses include `queued`, `rendering`, `ready`, and `failed`.

Approximate progress bands for clip/cut jobs: downloading 0–12%, transcription 12–55%, analysis 55–62%, rendering 62–99%, then complete at 100%. Download-only jobs use downloading from 0–99%.

Cancellation sets a database flag. The runner checks it during progress callbacks and between stages; this is cooperative, not an immediate OS-process termination. On backend startup, unfinished projects and non-ready clips are marked failed as interrupted; jobs are not resumed automatically. Retrying is available only for failed/cancelled projects.

### Clips Pipeline

1. **Prepare source:** Download YouTube media if needed (with optional range), or use uploaded media. Probe duration, dimensions and audio availability. Enforce maximum source duration.
2. **Audio analysis:** Extract mono 16 kHz WAV, calculate audio energy windows, and save waveform data.
3. **Transcribe:** Run faster-whisper with word timestamps/VAD. Store transcript JSON and detected language. Release the loaded model after transcription.
4. **No-speech guard:** If fewer than five words are detected and content type is not music, fail with `No speech was detected in this video. For songs, choose the Music content type.` Music mode is designed for speechless/music-like sources and skips this guard.
5. **Scene analysis:** Detect scene changes from the source video.
6. **Find moments:** `highlights.py` forms and scores candidate moments. Talking clips use transcript structure, hook/body, energy, peaks, scene changes, pacing, ending, and target-length fit. Gaming changes heuristic weights. Music scans windows and uses energy/peaks, repeated transcript segments as a chorus proxy, scene changes, and overlap avoidance.
7. **Optional AI reranking:** When `OPENAI_API_KEY` exists and a non-music transcript is considered reliable, candidates can be reranked with the configured OpenAI model. Errors fall back to heuristic ranking.
8. **Create clips:** Persist timing, title, score/reason, description/hashtags where available, caption groups, framing settings, and output metadata in SQLite.
9. **Render:** Render each clip separately. A failed individual render marks that clip failed; the project succeeds if at least one clip renders. If none render, the project fails.

A selected YouTube interval is already trimmed by yt-dlp; the runner analyzes the downloaded range from its local time zero. An uploaded file remains whole, and the runner limits candidate selection to the requested source-time span.

### Cut Pipeline

- Prepare and probe the source.
- Check the requested interval against the source duration.
- Analyze audio/waveform if audio exists.
- If captions were requested, transcribe the requested range with a source-time offset.
- Insert one clip record and render it.

### Download Pipeline

- Resolve video metadata and reject live streams.
- Use yt-dlp format selection. Video prefers H.264-compatible video and M4A audio where available and merges to MP4. Audio uses FFmpeg extraction to M4A or MP3.
- For a range, yt-dlp's range helper and forced keyframes are used. Download fragments are requested concurrently (8 workers).
- Persist output path, size, duration, title/channel/thumbnail and serve it through the project file endpoint.

### Framing, Captions And Encoding

The renderer builds a per-clip render plan from crop mode, aspect ratio, crop positions/zoom, PiP settings, and selected facecam/gameplay regions. Face-aware modes use OpenCV detection where applicable. Supported compositions include center/fill, directional/manual crop, split and flipped split, three-way split, PiP, blur fill and side-by-side. Multi-frame crops can be adjusted independently. The editor stores changes in clip fields and a render-affecting edit regenerates the clip.

Captions are grouped from word-level transcript timing and styled with Pillow. The implementation draws caption overlays per frame rather than relying on FFmpeg subtitle/drawtext filters; this supports styled and Indic-script text. Hooks can be rendered as an opening overlay. The output is encoded as MP4 (H.264 video/AAC audio where source audio exists) with generated thumbnails.

## API Reference

All JSON API routes are in `backend/app/main.py`; media assets are served under `/media`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Backend health and capability flags (FFmpeg, highlight engine, Whisper model names, Indic caption support). |
| `GET` | `/api/youtube/info?url=...` | Validate YouTube URL and return metadata/duration/thumbnail/available qualities. |
| `GET` | `/api/youtube/frame?url=...&time=...` | Download a short temporary segment and extract a preview frame. |
| `GET` | `/api/projects` | List projects. |
| `POST` | `/api/projects` | Create YouTube project; JSON `{url, mode, options}`. Returns `201`. |
| `POST` | `/api/projects/upload` | Multipart upload (`file`, `mode`, JSON-string `options`); clips and cut only. Returns `201`. |
| `GET` | `/api/projects/{id}` | Get project and its clips. |
| `DELETE` | `/api/projects/{id}` | Delete project/clip records and stored project files; terminal projects only. Returns `204`. |
| `POST` | `/api/projects/{id}/cancel` | Request cancellation of a nonterminal project. |
| `POST` | `/api/projects/{id}/retry` | Retry failed/cancelled project. Optional JSON `{content_type}` can override clip analyzer content type. |
| `GET` | `/api/projects/{id}/file` | Download completed Downloader-mode output. |
| `GET` | `/api/projects/{id}/analysis` | Read saved transcript and waveform analysis. |
| `GET` | `/api/projects/{id}/zip?clips=id,id` | Download ready clips and metadata/captions text; optional clip ID selection. |
| `PATCH` | `/api/clips/{id}` | Update clip metadata/edit settings; render-affecting changes queue a re-render. |
| `GET` | `/api/clips/{id}/download` | Download one ready clip. |
| `DELETE` | `/api/clips/{id}` | Delete clip and its files. Returns `204`. |
| `POST` | `/api/clips/{id}/duplicate` | Duplicate a ready clip and its output. Returns `201`. |
| `POST` | `/api/projects/{id}/apply-frame?source_clip_id=...` | Copy framing settings from one clip to other ready clips and queue renders. |

The API client in `src/api.js` centralizes requests. Set `VITE_API_BASE` for a separately hosted backend; in development it is empty and Vite proxies `/api` and `/media` to `http://127.0.0.1:8000`.

## Data And Files

- Default data root: `backend/data/`.
- SQLite DB: `backend/data/cliplabs.db`.
- Project media: `backend/data/media/<project-id>/`.
- Typical generated artifacts include source media, `audio.wav` (temporary; removed when the job ends), `waveform.json`, `transcript.json`, clip MP4s and thumbnails, and download-mode output. Temporary audio is cleaned after processing; waveform/transcript and clip outputs remain available for the project.
- Projects and clips are relational SQLite rows. JSON-valued fields (project options, captions, score breakdown, hashtags) are serialized in text columns. `db.py` applies additive column migrations at startup so an existing database can gain new fields.
- Project IDs and clip IDs are 32-character UUID hex strings.
- Media URLs are backend-relative and prefixed by `VITE_API_BASE` in cross-origin deployments. The backend uses version query parameters for clip URLs and `Cache-Control: no-store` on media responses to prevent stale edited media.

## Local Development

### Requirements

- Node.js compatible with Vite 7. The current Vite version recommends Node 20.19+ or 22.12+; Node 20.18 may still build but prints a warning.
- Python 3.12 (the setup script uses `python3.12`).
- FFmpeg and ffprobe on PATH.
- For Indic caption shaping on macOS, Pillow RAQM support and its system libraries are needed. The repo scripts set `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`; Homebrew `fribidi` is used for this setup.

### Install And Run

```sh
npm install
npm run setup:backend
npm run backend
```

In another terminal:

```sh
npm run dev
```

Open `http://127.0.0.1:4173/`. The Vite dev server proxies API and media requests to backend port 8000. Backend health is available at `http://127.0.0.1:8000/api/health`.

`npm run setup:backend` creates `backend/.venv` and installs `backend/requirements.txt`. If the configured package mirror is unavailable, the script currently uses the public PyPI index explicitly. Frontend dependencies are declared in `package.json`.

### Commands

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server on port 4173. |
| `npm run backend` | Start FastAPI/Uvicorn on `127.0.0.1:8000`. |
| `npm run build` | Create production frontend in `dist/`. |
| `npm run preview` | Preview the production build on port 4173. |
| `npm run test:backend` | Run backend pytest suite. |

Equivalent backend test command from the repo root: `cd backend && .venv/bin/python -m pytest -q` (on macOS, set `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` if needed).

The current automated tests are API and pipeline unit/integration tests. API tests stub background job submission; tests do not guarantee live YouTube availability, model downloads, full Whisper accuracy, or successful production encoding for arbitrary media.

## Configuration

Backend reads `backend/.env` via python-dotenv. Supported environment variables in `backend/app/config.py`:

| Variable | Default | Purpose |
|---|---|---|
| `CLIPLABS_DATA_DIR` | `backend/data` | Root for SQLite and media. Use persistent storage in production. |
| `OPENAI_API_KEY` | empty | Enables optional AI candidate reranking when transcript quality/content conditions allow. |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI ranking model. |
| `WHISPER_MODEL` | `base` | Default/English speech model. |
| `WHISPER_MULTILINGUAL_MODEL` | `small` | Model used for other supported languages. |
| `MAX_UPLOAD_MB` | `2048` | Server-side upload size cap in MiB. |
| `MAX_SOURCE_SECONDS` | 12 hours | Maximum source/range duration for supported processing. |
| `ALLOWED_ORIGINS` | localhost and 127.0.0.1 port 4173 | Comma-separated CORS origins. |
| `CAPTION_FONT` | macOS Arial Black path | Preferred caption font; renderer has fallback fonts for other platforms. |

Create `backend/.env` for local overrides; do not commit secrets. `GET /api/health` exposes useful runtime capability information, including whether FFmpeg and Indic RAQM support are available.

## Deployment

### Frontend

`npm run build` outputs `dist/`. `vercel.json` configures Vite build/output and rewrites SPA requests to `index.html`. The frontend can be deployed to Vercel or another static host.

For a separately hosted API, build with `VITE_API_BASE=https://<backend-origin>` and configure backend `ALLOWED_ORIGINS` to include the deployed frontend origin. The API base is compiled into the frontend build.

### Backend

The backend requires a persistent process, disk, FFmpeg, OpenCV, Whisper models and long-running background work. It is not deployed as a Vercel function in this project. Use a Docker-capable persistent host such as Railway, Render, or a VPS.

`backend/Dockerfile` uses Python 3.12 slim, installs FFmpeg and DejaVu fonts, and starts Uvicorn on `$PORT` (default 8000). `backend/railway.toml` configures the Dockerfile and health check. Mount persistent storage at `/data` and keep `CLIPLABS_DATA_DIR=/data`; otherwise database and media may disappear on container replacement. Configure CORS and any desired model/API environment variables on the host.

## Known Behavior And Limitations

- Only YouTube URLs are accepted for remote sources; live streams are rejected. Uploaded video supports `.mp4`, `.mov`, `.mkv`, `.webm`, and `.m4v`; upload mode is clips or cut only.
- UI copy has historically mentioned a 500 MB upload cap and AVI support, but current server defaults to 2048 MiB and rejects AVI. The server config and accepted extensions are authoritative.
- Music mode is a fallback analyzer for sources without speech; it does not magically recover speech transcription. For gaming or ambient sources, it ranks by music/audio energy and visual-scene cues, so resulting moments may not correspond to meaningful gameplay events.
- With fewer than five recognized words, non-music clips fail with the no-speech message. VAD can remove almost all audio for quiet, noisy, or non-speech sources.
- Create Clips and Manual Cut captions default to off and can be enabled explicitly in the form. The Clips API schema default is also off; caption style defaults to `classic`.
- Jobs live in in-process executors. Restarting the backend marks unfinished work failed rather than resuming it. This is a single-instance app design, not a distributed worker queue.
- The backend stores source and output assets on disk; disk capacity and persistent-volume configuration matter, especially for large sources and repeated projects.
- Generated outputs and models can consume substantial CPU, memory, disk, and startup/download time. The default Whisper models may be downloaded on first use.

## AI Recreation Brief

The following prompt can be given to a coding AI to recreate the application from this specification:

> Build a full-stack application named ClipLabs. It is a React 19 + Vite 7 SPA with a Python 3.12 FastAPI backend, SQLite persistence, and a local/persistent media directory. Use hash routes for Create (`#/`), Downloader (`#/download`), Projects (`#/projects`), and project detail (`#/projects/:32-hex-id`). Provide three workflows: (1) create 1–10 AI-highlight clips from a YouTube URL or uploaded video, with optional YouTube From/To range download, clip length/count, talking/music/gaming content type, multilingual transcription, captions, aspect/resolution/fps, source-area selection, and crop composition; (2) manually cut one interval from YouTube/uploaded video; (3) download YouTube video or audio in selected quality/format and optional time range. Add project list search/status/type filters, asynchronous progress polling, cancellation, retry, clip duplication/deletion, per-clip timeline/caption/style/crop/layout/PiP/hook editing, re-rendering, individual download and ZIP export.
>
> Backend endpoints and option validation should follow the API table and schemas in this README. Use yt-dlp for URL metadata, range downloads and format selection; FFmpeg/ffprobe for media/audio extraction and encoding; NumPy for waveform/energy, OpenCV for scene changes/face-aware framing, faster-whisper for word-timed transcripts, Pillow for caption overlays, and heuristic highlight scoring with optional OpenAI reranking. Keep project state in SQLite with additive migrations and files under a configurable data directory. Use background job execution with explicit queued/downloading/transcribing/analyzing/rendering/done/failed/cancelled states. Preserve source ranges and settings on retry; provide a no-speech recovery action that switches clips analysis to music only when explicitly selected. Serve media without stale browser caching.
>
> Keep the frontend responsive and usable on desktop/mobile, include accessible progress/error/confirmation states, and match the existing dark neutral/lime ClipLabs visual language if reproducing this exact product. Separate frontend and backend deployment: static SPA on Vercel or similar; persistent Docker backend with FFmpeg and a mounted data volume on Railway/Render/VPS. Include tests for schemas, API lifecycle and processing helpers. Do not claim live YouTube, Whisper, or full-render integration is covered by unit tests. Follow this README's current behavior and document deviations rather than silently inventing features.

## Primary Implementation References

- Frontend shell/routes/API: `src/App.jsx`, `src/api.js`, `src/constants.js`.
- Create form and settings: `src/components/CreatePanel.jsx`.
- Project list and detail: `src/pages/Projects.jsx`, `src/pages/ProjectDetail.jsx`.
- Clip editing and rendering controls: `src/components/ClipEditor.jsx`, `src/components/ClipCard.jsx`.
- API and DB: `backend/app/main.py`, `backend/app/schemas.py`, `backend/app/db.py`.
- Jobs and processing: `backend/app/jobs.py`, `backend/app/pipeline/runner.py` and the other modules under `backend/app/pipeline/`.
- Runtime and deploy: `backend/app/config.py`, `backend/Dockerfile`, `backend/railway.toml`, `vite.config.js`, `vercel.json`.

## Improvement Prompts

Use this prompt catalog when planning focused improvements. Paste the Base Prompt first, then exactly one improvement prompt. Keep each improvement in a separate AI chat/task. Suggested order: **#4 → #1 → #5 → #3 → #2**; small fixes first, larger changes later. Commit completed work only after reviewing and testing it.

### Base Prompt

```text
Tu ClipLabs repo pe kaam kar raha hai (React 19 + Vite 7 frontend, FastAPI + SQLite + FFmpeg/yt-dlp/faster-whisper backend). README is project ka current behavior describe karta hai.

Rules:
1. Pehle relevant files padh (backend/app/main.py, schemas.py, db.py, jobs.py, pipeline/runner.py, aur jo bhi touch hoga). Bina padhe code mat likh.
2. Pehle chhota plan de: kaunsi files badlengi, kyun, aur kya risk hai. Mere "go" bolne ke baad hi code likh.
3. Minimal change kar. Existing API contract, DB schema (sirf additive migration), aur UI style mat tod.
4. Naye behavior ke liye tests likh (backend/tests/). Last mein `npm run test:backend` chala aur result bata.
5. Jo cheez verify nahi kar paaya (live YouTube, Whisper, full render), uske baare mein saaf bol, "works" mat claim kar.
6. Kaam ke baad README ke affected sections update kar.
```

### 1. Silent Gaming Videos

```text
Problem: no-speech guard (<5 words) sirf content_type=music pe bypass hota hai. Silent gameplay fail ho jaata hai.
Kaam: gaming content_type ke liye no-speech guard bypass kar, aur highlights.py mein gaming ke liye audio-energy peaks + scene-change density pe based fallback scoring add kar jab transcript unreliable ho. "Retry as Music" button sirf talking ke liye rakh. Tests add kar.
```

### 2. Authentication And User Separation

```text
Problem: koi auth nahi hai, /api/projects se koi bhi sab projects dekh/delete kar sakta hai.
Kaam: lightweight auth add kar (simple email+password ya magic link, JWT cookie). projects table mein user_id column (additive migration). Saare /api/projects* aur /api/clips* routes sirf owner ke liye. /media files ke liye signed URLs ya ownership check. Frontend mein login page aur 401 handling. Pehle plan de, kyunki ye bada change hai.
```

### 3. Resume Jobs After Restart

```text
Problem: backend restart pe unfinished projects failed ho jaate hain.
Kaam: runner.py mein stage checkpoints add kar (source downloaded, transcript.json saved, clips created). Startup pe interrupted projects ko failed mark karne ki jagah queued kar, aur runner existing artifacts (source, transcript.json) dekh ke us stage se resume kare. Jo clips already ready hain unhe dobara render mat kar.
```

### 4. Caption UX Consistency

```text
Problem: schema default captions=true hai par Create UI false bhejta hai, aur Manual Cut mein caption toggle nahi hai.
Kaam: CreatePanel.jsx mein Clips aur Manual Cut dono ke liye ek caption toggle + caption style picker add kar. Default ek hi rakh (UI aur schema match karein). Cut mode mein captions on hone pe transcription range ke offset ke saath chale.
```

### 5. Failed Clip Retry And Partial Failure Visibility

```text
Problem: ek clip bhi render ho jaaye toh project done dikhta hai, failed clips ka retry nahi hai.
Kaam: ClipCard mein failed clip pe error message aur "Retry render" button add kar. Naya endpoint POST /api/clips/{id}/retry. Project detail pe "3 of 5 clips ready" jaisa summary badge dikha.
```

### 6. Queue Fairness

```text
Problem: single worker queue hai, ek lamba job baaki sab block karta hai.
Kaam: download-only jobs ko clips/transcription queue se alag executor mein daal. Queue position UI mein dikha ("2nd in queue"). Whisper/render wale heavy jobs single rahein.
```

### 7. Disk Cleanup

```text
Problem: source media aur outputs kabhi delete nahi hote.
Kaam: config mein RETENTION_DAYS add kar. Startup pe aur daily background task se terminal projects ke source media (clips ke alawa) purge kar. Project detail pe storage used dikha.
```

### 8. SSE Progress

```text
Problem: 3 sec polling heavy aur laggy hai.
Kaam: GET /api/projects/{id}/events SSE endpoint add kar jo status/progress push kare. Frontend mein SSE use kar, fail hone pe polling fallback rakh.
```

### 9. Small Fixes

```text
1. UI copy mein purana "500 MB" aur "AVI" text hata, real limit 2048 MiB aur accepted extensions (.mp4 .mov .mkv .webm .m4v) dikha.
2. /api/youtube/frame pe rate limit + short-lived cache laga.
3. Upload resumable (chunked) banane ka plan de, abhi code mat likh.
```

### Usage Tips

- Agar AI bina plan ke code likhna shuru kare, bolo: "Ruk, pehle plan de."
- Auth jaise bade changes naye branch par karo.
- Railway jaise cloud IPs par YouTube bot-check ya age-restriction download rok sakte hain; ise alag se test karo.
- Ek chat mein ek improvement rakho. Har change ke tests aur README updates usi task ka hissa hon.
