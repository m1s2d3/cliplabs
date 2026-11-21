import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ASPECTS, CONTENT_TYPES, LANGUAGES, LENGTHS, MODES } from '../constants';
import { clock, isYouTubeUrl, navigate, parseTime } from '../utils';

const infoCache = new Map();

const DEFAULT_QUALITIES = [1080, 720, 480, 360];

function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}
function clockMs(sec) {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  return `${pad2(safe / 60)}:${pad2(safe % 60)}`;
}

export default function CreatePanel({ notify, health }) {
  const [mode, setMode] = useState('clips');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState({ status: 'idle' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [youtubePlaying, setYoutubePlaying] = useState(false);
  const [playTime, setPlayTime] = useState(0);
  const [fileDuration, setFileDuration] = useState(0);
  const fileInput = useRef(null);
  const videoRef = useRef(null);

  const [clipCount, setClipCount] = useState(5);
  const [length, setLength] = useState('auto');
  const [language, setLanguage] = useState('auto');
  const [contentType, setContentType] = useState('talking');
  const [aspect, setAspect] = useState('9:16');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  const [cutStart, setCutStart] = useState('0:00');
  const [cutEnd, setCutEnd] = useState('0:30');
  const [cutAspect, setCutAspect] = useState('original');

  const [kind, setKind] = useState('video');
  const [quality, setQuality] = useState('1080');
  const [audioFormat, setAudioFormat] = useState('m4a');

  const info = preview.status === 'ready' ? preview.info : null;
  const qualities = info?.qualities?.length ? info.qualities : DEFAULT_QUALITIES;

  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);

  const totalDuration = info?.duration || fileDuration || 0;
  const currentAspect = mode === 'cut' ? cutAspect : aspect;
  const setCurrentAspect = mode === 'cut' ? setCutAspect : setAspect;
  const playPct = Math.min(100, Math.max(0, (playTime / Math.max(1, totalDuration)) * 100));

  useEffect(() => {
    const value = url.trim();
    if (!value || file) {
      setPreview({ status: 'idle' });
      return undefined;
    }
    if (!isYouTubeUrl(value)) {
      setPreview({ status: 'invalid' });
      return undefined;
    }
    if (infoCache.has(value)) {
      setPreview({ status: 'ready', info: infoCache.get(value) });
      return undefined;
    }
    setPreview({ status: 'loading' });
    let stale = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.youtubeInfo(value);
        infoCache.set(value, result);
        if (!stale) setPreview({ status: 'ready', info: result });
      } catch (err) {
        if (!stale) setPreview({ status: 'error', error: err.message });
      }
    }, 500);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [url, file]);

  useEffect(() => {
    if (info && !qualities.includes(Number(quality))) setQuality(String(qualities[0]));
  }, [info, qualities, quality]);

  useEffect(() => {
    if (mode === 'download' && file) setFile(null);
  }, [mode, file]);

  const pickFile = (picked) => {
    if (!picked) return;
    if (mode === 'download') {
      setError('Download mode works with YouTube links. Switch to AI Clips or Manual Cut to use a file.');
      return;
    }
    if (!picked.type.startsWith('video/') && !/\.(mp4|mov|mkv|webm|m4v)$/i.test(picked.name)) {
      setError('Please choose a video file (mp4, mov, mkv, webm).');
      return;
    }
    setFile(picked);
    setUrl('');
    setError('');
    setIsPlaying(false);
    setPlayTime(0);
  };

  const togglePreviewPlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) { el.play(); setIsPlaying(true); } else { el.pause(); setIsPlaying(false); }
  };

  const changeContentType = (value) => {
    setContentType(value);
  };

  const validate = () => {
    if (health === null) return 'The backend is offline. Start it with npm run backend.';
    const value = url.trim();
    if (!file && !value) return 'Paste a YouTube link or upload a video to get started.';
    if (!file && !isYouTubeUrl(value)) return 'That doesn’t look like a YouTube link.';
    if (!file && preview.status === 'error') return preview.error;
    if (!file && info?.is_live) return 'Live streams are not supported.';
    const duration = file ? null : info?.duration;
    if (mode === 'cut') {
      const start = parseTime(cutStart);
      const end = parseTime(cutEnd);
      if (Number.isNaN(start) || Number.isNaN(end)) return 'Use times like 1:23 or 83.';
      if (end - start < 1) return 'End must be at least 1 second after start.';
      if (end - start > 600) return 'A cut can be up to 10 minutes long.';
      if (duration && start >= duration) return `Start is after the end of the video (${clock(duration)}).`;
    }
    if (mode === 'clips' && (rangeStart || rangeEnd)) {
      const start = rangeStart ? parseTime(rangeStart) : 0;
      const end = rangeEnd ? parseTime(rangeEnd) : duration ?? Infinity;
      if (Number.isNaN(start) || Number.isNaN(end)) return 'Use times like 10:00 for the analysis range.';
      if (end - start < LENGTHS[length].min_length) return 'The analysis range is shorter than the clip length.';
    }
    return '';
  };

  const buildOptions = () => {
    if (mode === 'download') return { kind, quality, audio_format: audioFormat };
    if (mode === 'cut') {
      const end = parseTime(cutEnd);
      return {
        start: parseTime(cutStart),
        end: info?.duration ? Math.min(end, info.duration) : end,
        aspect: cutAspect,
        captions: false,
        language,
      };
    }
    const { min_length, max_length } = LENGTHS[length];
    return {
      clip_count: clipCount,
      min_length,
      max_length,
      captions: false,
      language,
      content_type: contentType,
      aspect,
      range_start: rangeStart ? parseTime(rangeStart) : null,
      range_end: rangeEnd ? parseTime(rangeEnd) : null,
    };
  };

  const submit = async (event) => {
    event.preventDefault();
    const problem = validate();
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const options = buildOptions();
      const project = file ? await api.uploadVideo(file, mode, options, setUploadProgress) : await api.createProject(url.trim(), mode, options);
      notify(mode === 'download' ? 'Download started.' : 'Your video is queued.');
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    pickFile(event.dataTransfer.files?.[0]);
  };

  const actionLabel = mode === 'download' ? `Download ${kind}` : mode === 'clips' ? `Generate ${clipCount} Clips` : 'Create Clip';
  const buttonLabel = !busy ? actionLabel : uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%` : 'Starting…';
  const autoReframe = currentAspect !== 'original';

  useEffect(() => {
    setYoutubePlaying(false);
  }, [info?.id]);

  return (
    <form className="editor-studio" onSubmit={submit}>
      <header className="studio-header">
        <div className="workspace-heading">
          <h1>Video Clip <em>Editor</em></h1>
          <p>Trim, cut and create engaging clips from your videos effortlessly.</p>
        </div>
        <div className="studio-header-right">
          <div className="mode-tabs studio-tabs" role="tablist" aria-label="What do you want to do?">
            {MODES.map((item) => (
              <button key={item.key} type="button" role="tab" aria-selected={mode === item.key} className={mode === item.key ? 'active' : ''} onClick={() => { setMode(item.key); setError(''); }} title={item.hint} disabled={busy}>
                <span>{item.icon}</span>{item.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="studio-stage-grid">
        <div className="preview-player-card">
          <div className="preview-canvas">
            {fileUrl ? (
              <video
                ref={videoRef}
                src={fileUrl}
                onLoadedMetadata={(e) => setFileDuration(e.currentTarget.duration || 0)}
                onTimeUpdate={(e) => setPlayTime(e.currentTarget.currentTime)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onClick={togglePreviewPlay}
              />
            ) : info?.id ? (
              youtubePlaying ? (
                <iframe
                  className="youtube-embed"
                  src={`https://www.youtube.com/embed/${info.id}?autoplay=1&modestbranding=1&rel=0`}
                  title={info.title || 'YouTube preview'}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <button type="button" className="youtube-poster" onClick={() => setYoutubePlaying(true)} aria-label={`Play ${info.title || 'YouTube video'}`}>
                  {info.thumbnail ? <img src={info.thumbnail} alt="" /> : <div className="youtube-poster-fallback" aria-hidden="true">▶</div>}
                  <span className="youtube-poster-shade" />
                  <span className="youtube-poster-title">{info.title || 'YouTube video'}</span>
                  <span className="youtube-play-button" aria-hidden="true">▶</span>
                </button>
              )
            ) : (
              <div className="preview-placeholder-scene">
                <div className="preview-scene-glow" />
                <div className="preview-scene-badge">✦ ClipLabs Studio</div>
                <p>Drop a video or fetch a YouTube link to preview here</p>
              </div>
            )}
            {fileUrl && (
              <div className="preview-controls-bar">
                <button type="button" className="transport-play" onClick={togglePreviewPlay} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? '❚❚' : '▶'}</button>
                <span className="transport-time">{clockMs(playTime)} / {clockMs(totalDuration)}</span>
                <div className="transport-scrubber">
                  <div className="transport-track"><div className="transport-fill" style={{ width: `${playPct}%` }} /><span className="transport-dot" style={{ left: `${playPct}%` }} /></div>
                </div>
                <span className="transport-icons" aria-hidden="true">🔊 CC ⛶</span>
              </div>
            )}
          </div>
        </div>

        <div className={`dropzone-card ${mode === 'download' ? 'download-only' : ''} ${dragging ? 'dragging' : ''} ${error ? 'has-error' : ''}`} onDragOver={(e) => { if (mode !== 'download') { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={mode === 'download' ? undefined : onDrop}>
          {mode === 'download' ? (
            <div className="download-source-hint">
              <div className="dropzone-icon" aria-hidden="true">🔗</div>
              <h2>Paste a YouTube link</h2>
              <p>Download mode only works with YouTube links, not uploaded files.</p>
            </div>
          ) : (
            <>
              <div className="dropzone-upper">
                <div className="dropzone-icon" aria-hidden="true">☁</div>
                {file ? (
                  <div className="file-chip studio-file-chip">
                    <strong>{file.name}</strong>
                    <small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>
                    <button type="button" aria-label="Remove file" onClick={() => setFile(null)} disabled={busy}>×</button>
                  </div>
                ) : (
                  <>
                    <h2>Drop your video here</h2>
                    <p>or click to browse</p>
                    <small>Supports MP4, MOV, AVI, WEBM · Up to 500MB</small>
                    <button type="button" className="choose-file-btn" onClick={() => fileInput.current?.click()} disabled={busy}><span>⤓</span> Choose File</button>
                  </>
                )}
              </div>
              <input ref={fileInput} type="file" accept="video/*,.mkv" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />

              <div className="dropzone-or"><span>OR</span></div>
            </>
          )}

          <div className="youtube-fetch-row">
            <span className="yt-link-icon" aria-hidden="true">🔗</span>
            <input id="source-video" aria-label="YouTube link" aria-invalid={Boolean(error)} placeholder="Paste YouTube link here" value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }} disabled={busy} />
          </div>
          {!file && <LinkPreview preview={preview} />}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      </section>

      <section className="studio-controls-bar">
        {mode !== 'download' ? (
          <>
            <label className="control-box select">
              <span>Output Format</span>
              <select value={currentAspect} onChange={(e) => setCurrentAspect(e.target.value)} disabled={busy}>
                <option value="original">MP4 (Original)</option>
                {ASPECTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <div className="control-checks">
              <label className="check"><input type="checkbox" checked={autoReframe} onChange={(e) => setCurrentAspect(e.target.checked ? '9:16' : 'original')} disabled={busy} />Auto Reframe</label>
            </div>
            {mode === 'clips' && (
              <label className="control-box select">
                <span>Analyze range</span>
                <div className="range-inline">
                  <input type="text" placeholder="0:00" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} disabled={busy} />
                  <span>to</span>
                  <input type="text" placeholder={totalDuration ? clock(totalDuration) : 'end'} value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} disabled={busy} />
                </div>
              </label>
            )}
          </>
        ) : (
          <div className="download-controls-inline">
            <div className="segmented" role="radiogroup" aria-label="Download type">
              {['video', 'audio'].map((value) => <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)} disabled={busy}>{value === 'video' ? '▶ Video' : '♪ Audio'}</button>)}
            </div>
            {kind === 'video' ? (
              <label className="control-box select"><span>Quality</span><select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={busy}>{qualities.map((h) => <option key={h} value={h}>{h}p{h >= 2160 ? ' 4K' : ''}</option>)}</select></label>
            ) : (
              <label className="control-box select"><span>Format</span><select value={audioFormat} onChange={(e) => setAudioFormat(e.target.value)} disabled={busy}><option value="m4a">M4A (original quality)</option><option value="mp3">MP3 (plays everywhere)</option></select></label>
            )}
          </div>
        )}
        <button className="create-clip-cta" type="submit" disabled={busy}>{buttonLabel} <span>→</span></button>
      </section>

      {mode === 'clips' && (
        <details className="advanced studio-advanced" open>
          <summary>AI options · {clipCount} clips · {CONTENT_TYPES.find(([k]) => k === contentType)?.[1]}</summary>
          <div className="advanced-grid">
            <label>Clips<select value={clipCount} onChange={(e) => setClipCount(Number(e.target.value))} disabled={busy}>{[3, 5, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            <label>Length<select value={length} onChange={(e) => setLength(e.target.value)} disabled={busy}>{Object.entries(LENGTHS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
            <label>Content<select value={contentType} onChange={(e) => changeContentType(e.target.value)} disabled={busy}>{CONTENT_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>Language<select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>{LANGUAGES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
          {language !== 'auto' && language !== 'en' && <p className="hint">Non-English speech uses a larger, more accurate model. The first run downloads it once (~480 MB).</p>}
        </details>
      )}
    </form>
  );
}

function LinkPreview({ preview }) {
  if (preview.status === 'idle') return null;
  if (preview.status === 'invalid') return <p className="form-hint">Paste a youtube.com or youtu.be link.</p>;
  if (preview.status === 'loading') {
    return <p className="form-hint">Fetching video details…</p>;
  }
  if (preview.status === 'error') return <p className="form-error" role="alert">{preview.error}</p>;
  // Ready state: the large preview player on the left already shows the fetched video.
  return null;
}
