import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ASPECTS, CONTENT_TYPES, LANGUAGES, LENGTHS } from '../constants';
import { clock, isYouTubeUrl, navigate, parseTime } from '../utils';
import CaptionStylePicker from './CaptionStylePicker';

const infoCache = new Map();

const DEFAULT_QUALITIES = [1080, 720, 480, 360];
const clampArea = (value, min, max) => Math.min(max, Math.max(min, value));
const LAYOUT_PRESETS = [
  { id: 'face-game', label: 'Face + gameplay', detail: 'Camera above the action', mode: 'split', icon: 'stack-top' },
  { id: 'game-face', label: 'Gameplay + face', detail: 'Camera below the action', mode: 'split_flip', icon: 'stack-bottom' },
  { id: 'blur', label: 'Blurred fill', detail: 'Keep the complete source', mode: 'blur_fill', icon: 'blur' },
  { id: 'fill', label: 'Fill screen', detail: 'Full-frame centre crop', mode: 'center', icon: 'full' },
  { id: 'game-only', label: 'Gameplay only', detail: 'Use the full frame', mode: 'manual', icon: 'full' },
  ...[['top_left', 'Top-left', 'pip-tl'], ['top_right', 'Top-right', 'pip-tr'], ['bottom_left', 'Bottom-left', 'pip-bl'], ['bottom_right', 'Bottom-right', 'pip-br']].map(([position, label, icon]) => ({ id: `camera-${position}`, label: `Camera ${label.toLowerCase()}`, detail: 'Floating facecam', mode: 'pip', position, shape: 'square', icon })),
  { id: 'circle', label: 'Circle camera', detail: 'Round facecam overlay', mode: 'pip', position: 'bottom_right', shape: 'circle', icon: 'circle' },
  { id: 'side', label: 'Side by side', detail: 'Camera and gameplay columns', mode: 'side_by_side', icon: 'columns' },
];

function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}
function clockMs(sec) {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  return `${pad2(safe / 60)}:${pad2(safe % 60)}`;
}

export default function CreatePanel({ notify, health, initialMode = 'clips' }) {
  const [mode] = useState(initialMode);
  const [url, setUrl] = useState('');
  const [lookupUrl, setLookupUrl] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState({ status: 'idle' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [scenePreviewTime, setScenePreviewTime] = useState(0);
  const [sceneFrameRequestTime, setSceneFrameRequestTime] = useState(0);
  const [youtubeFrameUrl, setYoutubeFrameUrl] = useState(null);
  const [playTime, setPlayTime] = useState(0);
  const [fileDuration, setFileDuration] = useState(0);
  const fileInput = useRef(null);
  const videoRef = useRef(null);
  const outputVideoRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const areaDragStart = useRef(null);
  const youtubeFrameUrlRef = useRef(null);

  const [clipCount, setClipCount] = useState(5);
  const [length, setLength] = useState('auto');
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionStyle, setCaptionStyle] = useState('classic');
  const [language, setLanguage] = useState('auto');
  const [contentType, setContentType] = useState('talking');
  const [aspect, setAspect] = useState('9:16');
  const [outputResolution, setOutputResolution] = useState(1080);
  const [frameRate, setFrameRate] = useState(30);
  const [customWidth, setCustomWidth] = useState(1080);
  const [customHeight, setCustomHeight] = useState(1920);
  const [layoutId, setLayoutId] = useState('fill');
  const [facecamPosition, setFacecamPosition] = useState('bottom_right');
  const [findFacecam, setFindFacecam] = useState(true);
  const [areaTarget, setAreaTarget] = useState(null);
  const [areaShapes, setAreaShapes] = useState({ facecam: 'square', gameplay: '9:16' });
  const [sourceAreas, setSourceAreas] = useState({ facecam: null, gameplay: null });
  const [areaDrag, setAreaDrag] = useState(null);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  const [cutStart, setCutStart] = useState('0:00');
  const [cutEnd, setCutEnd] = useState('0:30');
  const [downloadFrom, setDownloadFrom] = useState('');
  const [downloadTo, setDownloadTo] = useState('');
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
  const aspectGroup = currentAspect === '9:16' ? 'vertical'
    : currentAspect === '16:9' ? 'wide'
      : currentAspect === '1:1' ? 'square'
        : currentAspect === 'custom' ? customWidth / customHeight < 0.8 ? 'vertical' : customWidth / customHeight > 1.25 ? 'wide' : 'square'
          : 'original';
  const availableLayouts = LAYOUT_PRESETS.filter((item) => {
    if (aspectGroup === 'vertical') return item.mode !== 'side_by_side';
    if (aspectGroup === 'wide') return !['split', 'split_flip'].includes(item.mode);
    return true;
  });
  const selectedLayout = LAYOUT_PRESETS.find((item) => item.id === layoutId) || LAYOUT_PRESETS[0];
  const sectionTargets = {
    split: { facecam: 'Top section · Camera', gameplay: 'Bottom section · Gameplay' },
    split_flip: { facecam: 'Bottom section · Camera', gameplay: 'Top section · Gameplay' },
    side_by_side: { facecam: 'Left section · Camera', gameplay: 'Right section · Gameplay' },
    pip: { facecam: 'PiP overlay · Camera', gameplay: 'Background · Gameplay' },
  }[selectedLayout.mode] || { facecam: 'Facecam crop', gameplay: 'Main frame · Gameplay' };
  const frameTargets = ['split', 'split_flip', 'side_by_side', 'pip'].includes(selectedLayout.mode)
    ? ['facecam', 'gameplay']
    : ['gameplay'];
  const areaShape = areaShapes[areaTarget] || 'square';
  const validAreaShapes = selectedLayout.mode === 'pip' && areaTarget === 'facecam'
    ? ['circle', 'square', 'freeform']
    : ['square', '9:16', '16:9', 'freeform'];
  const playPct = Math.min(100, Math.max(0, (playTime / Math.max(1, totalDuration)) * 100));

  useEffect(() => {
    if (availableLayouts.some((item) => item.id === layoutId)) return;
    const preferredLayout = aspectGroup === 'wide' ? 'side' : aspectGroup === 'vertical' ? 'face-game' : 'fill';
    setLayoutId(preferredLayout);
    setAreaTarget(null);
    setSourceAreas({ facecam: null, gameplay: null });
  }, [aspectGroup, layoutId]);

  useEffect(() => {
    const value = lookupUrl.trim();
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
  }, [lookupUrl, file]);

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
    setLookupUrl('');
    setSourceAreas({ facecam: null, gameplay: null });
    setAreaTarget(null);
    setAreaDrag(null);
    setError('');
    setIsPlaying(false);
    setPlayTime(0);
  };

  const togglePreviewPlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) { el.play(); setIsPlaying(true); } else { el.pause(); setIsPlaying(false); }
  };

  const syncOutputPreview = (time = videoRef.current?.currentTime || 0) => {
    const output = outputVideoRef.current;
    if (output && Number.isFinite(time) && Math.abs(output.currentTime - time) > 0.12) output.currentTime = time;
  };

  const seekScenePreview = (time) => {
    setScenePreviewTime(time);
    setSceneFrameRequestTime(Math.floor(time));
  };

  const outputAspectRatio = currentAspect === 'custom'
    ? `${customWidth} / ${customHeight}`
    : ({ '9:16': '9 / 16', '1:1': '1 / 1', '16:9': '16 / 9' }[currentAspect] || '16 / 9');
  const outputRatio = currentAspect === 'custom'
    ? customWidth / customHeight
    : ({ '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 }[currentAspect] || 16 / 9);
  const scenePreviewImage = sceneFrameRequestTime > 0 && youtubeFrameUrl ? youtubeFrameUrl : info?.thumbnail;
  const sourceCropStyle = (area) => {
    if (!area) return undefined;
    const [x, y, width, height] = area;
    const sourceWidth = file ? videoRef.current?.videoWidth : info?.width;
    const sourceHeight = file ? videoRef.current?.videoHeight : info?.height;
    const sourceRatio = sourceWidth && sourceHeight ? sourceWidth / sourceHeight : 16 / 9;
    const areaRatio = width * sourceRatio / height;
    let cropWidth = width;
    let cropHeight = height;
    if (areaRatio > outputRatio) cropWidth = height * outputRatio / sourceRatio;
    else cropHeight = width * sourceRatio / outputRatio;
    const cropX = x + (width - cropWidth) / 2;
    const cropY = y + (height - cropHeight) / 2;
    return {
      position: 'absolute',
      left: `${(-cropX / cropWidth) * 100}%`,
      top: `${(-cropY / cropHeight) * 100}%`,
      width: `${100 / cropWidth}%`,
      height: `${100 / cropHeight}%`,
      maxWidth: 'none',
      objectFit: 'fill',
    };
  };

  const changeContentType = (value) => {
    setContentType(value);
  };

  const areaPoint = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    ];
  };

  const defaultArea = (shape) => {
    const canvas = previewCanvasRef.current?.getBoundingClientRect();
    const canvasRatio = canvas?.width && canvas?.height ? canvas.width / canvas.height : 16 / 9;
    const ratios = { square: 1, '9:16': 9 / 16, '16:9': 16 / 9, circle: 1 };
    const ratio = ratios[shape];
    let width = shape === 'freeform' ? 0.5 : Math.min(0.62, Math.sqrt(ratio / canvasRatio) * 0.62);
    let height = shape === 'freeform' ? 0.38 : width * canvasRatio / ratio;
    if (height > 0.62) {
      height = 0.62;
      width = height * ratio / canvasRatio;
    }
    return [(1 - width) / 2, (1 - height) / 2, width, height];
  };

  const chooseAreaTarget = (target) => {
    if (areaTarget === target) {
      setAreaTarget(null);
      return;
    }
    setAreaTarget(target);
    const shape = areaShapes[target] || 'square';
    setSourceAreas((current) => ({ ...current, [target]: current[target] || defaultArea(shape) }));
  };

  const chooseAreaShape = (shape) => {
    if (!areaTarget) return;
    setAreaShapes((current) => ({ ...current, [areaTarget]: shape }));
    setSourceAreas((current) => ({ ...current, [areaTarget]: defaultArea(shape) }));
  };

  const startAreaSelection = (event) => {
    const box = event.target.closest('.source-area-box');
    if (!box || !areaTarget) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = areaPoint(event);
    const rect = sourceAreas[areaTarget] || defaultArea(areaShape);
    areaDragStart.current = { point, rect, resizing: Boolean(event.target.closest('.source-area-resize')) };
    setAreaDrag({ target: areaTarget, rect });
  };

  const moveAreaSelection = (event) => {
    if (!areaDragStart.current || !areaTarget) return;
    const { point: [x, y], rect: initial, resizing } = areaDragStart.current;
    const [pointerX, pointerY] = areaPoint(event);
    let rect;
    if (resizing) {
      let width;
      let height;
      if (areaShape === 'freeform') {
        width = clampArea(initial[2] + pointerX - x, 0.06, 1 - initial[0]);
        height = clampArea(initial[3] + pointerY - y, 0.06, 1 - initial[1]);
      } else {
        const ratio = areaShape === '9:16' ? 9 / 16 : areaShape === '16:9' ? 16 / 9 : 1;
        const normalizedRatio = ratio * (previewCanvasRef.current.clientHeight / previewCanvasRef.current.clientWidth);
        const widthDelta = pointerX - x;
        const heightDeltaAsWidth = (pointerY - y) * normalizedRatio;
        const proposedWidth = initial[2] + (Math.abs(widthDelta) > Math.abs(heightDeltaAsWidth) ? widthDelta : heightDeltaAsWidth);
        const maxWidth = Math.min(1 - initial[0], (1 - initial[1]) * normalizedRatio);
        const minWidth = Math.min(maxWidth, Math.max(0.02, 0.06 * normalizedRatio));
        width = clampArea(proposedWidth, minWidth, maxWidth);
        height = width / normalizedRatio;
      }
      rect = [initial[0], initial[1], width, height];
    } else {
      const dx = pointerX - x;
      const dy = pointerY - y;
      rect = [
        clampArea(initial[0] + dx, 0, 1 - initial[2]),
        clampArea(initial[1] + dy, 0, 1 - initial[3]),
        initial[2], initial[3],
      ];
    }
    setAreaDrag({ target: areaTarget, rect });
    setSourceAreas((current) => ({ ...current, [areaTarget]: rect }));
  };

  const finishAreaSelection = () => {
    areaDragStart.current = null;
    setAreaDrag(null);
  };

  const validate = () => {
    if (health === null) return 'The backend is offline. Start it with npm run backend.';
    if (mode !== 'download' && currentAspect === 'custom') {
      if (![customWidth, customHeight].every((value) => Number.isInteger(value) && value >= 144 && value <= 4320 && value % 2 === 0)) {
        return 'Custom frame dimensions must be even numbers between 144 and 4320 pixels.';
      }
    }
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
    if (mode === 'download' && (downloadFrom || downloadTo)) {
      const start = downloadFrom ? parseTime(downloadFrom) : 0;
      const end = downloadTo ? parseTime(downloadTo) : duration ?? NaN;
      if (Number.isNaN(start) || Number.isNaN(end)) return 'Enter valid From and To times, such as 1:15 or 75.';
      if (start < 0 || end <= start) return 'To time must be after From time.';
      if (duration && end > duration) return `To time is past the video duration (${clock(duration)}).`;
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
    if (mode === 'download') return {
      kind,
      quality,
      audio_format: audioFormat,
      ...(downloadFrom || downloadTo ? {
        range_start: downloadFrom ? parseTime(downloadFrom) : 0,
        range_end: downloadTo ? parseTime(downloadTo) : info?.duration,
      } : {}),
    };
    if (mode === 'cut') {
      const end = parseTime(cutEnd);
      return {
        start: parseTime(cutStart),
        end: info?.duration ? Math.min(end, info.duration) : end,
        aspect: cutAspect,
        output_resolution: outputResolution,
        frame_rate: frameRate,
        output_width: customWidth,
        output_height: customHeight,
        captions: captionsEnabled,
        caption_style: captionStyle,
        language,
      };
    }
    const { min_length, max_length } = LENGTHS[length];
    return {
      clip_count: clipCount,
      min_length,
      max_length,
      captions: captionsEnabled,
      caption_style: captionStyle,
      language,
      content_type: contentType,
      aspect,
      crop_mode: selectedLayout.mode,
      pip_position: facecamPosition,
      pip_shape: selectedLayout.shape || 'square',
      find_facecam: findFacecam,
      facecam_area: sourceAreas.facecam,
      gameplay_area: sourceAreas.gameplay,
      output_resolution: outputResolution,
      output_width: customWidth,
      output_height: customHeight,
      frame_rate: frameRate,
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
  useEffect(() => {
    setScenePreviewTime(0);
    setSceneFrameRequestTime(0);
    setYoutubeFrameUrl(null);
    if (youtubeFrameUrlRef.current) {
      URL.revokeObjectURL(youtubeFrameUrlRef.current);
      youtubeFrameUrlRef.current = null;
    }
  }, [info?.id]);

  useEffect(() => {
    if (!url || !info?.id) return undefined;
    const timestamp = sceneFrameRequestTime;
    let stale = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(api.youtubeFrameUrl(url, timestamp));
        if (!response.ok) return;
        const nextUrl = URL.createObjectURL(await response.blob());
        if (stale) URL.revokeObjectURL(nextUrl);
        else {
          if (youtubeFrameUrlRef.current) URL.revokeObjectURL(youtubeFrameUrlRef.current);
          youtubeFrameUrlRef.current = nextUrl;
          setYoutubeFrameUrl(nextUrl);
        }
      } catch {
        return;
      }
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [url, info?.id, sceneFrameRequestTime]);

  useEffect(() => {
    const output = outputVideoRef.current;
    if (!output || !fileUrl) return;
    syncOutputPreview();
    if (isPlaying) output.play().catch(() => {});
    else output.pause();
  }, [isPlaying, fileUrl]);

  return (
    <form className={`editor-studio${mode === 'download' ? ' downloader-studio' : ''}`} onSubmit={submit}>
      <header className="studio-header">
        <div className="workspace-heading">
          {mode === 'download' ? <h1>Video <em>Downloader</em></h1> : <h1>Video Clip <em>Editor</em></h1>}
          <p>{mode === 'download' ? 'Download a YouTube video or audio in your preferred quality.' : 'Trim, cut and create engaging clips from your videos effortlessly.'}</p>
        </div>
      </header>

      <div className={`dropzone-card source-input-card ${mode === 'download' ? 'download-only' : ''} ${dragging ? 'dragging' : ''} ${error ? 'has-error' : ''}`} onDragOver={(e) => { if (mode !== 'download') { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={mode === 'download' ? undefined : onDrop}>
        {mode !== 'download' && <>
          <div className="dropzone-upper">
            <div className="dropzone-icon" aria-hidden="true">☁</div>
            {file ? (
              <div className="file-chip studio-file-chip">
                <strong>{file.name}</strong>
                <small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>
                <button type="button" aria-label="Remove file" onClick={() => setFile(null)} disabled={busy}>×</button>
              </div>
            ) : <>
              <div className="dropzone-copy"><h2>Drop your video here</h2><p>or click to browse</p><small>MP4, MOV, AVI, WEBM · Up to 500MB</small></div>
              <button type="button" className="choose-file-btn" onClick={() => fileInput.current?.click()} disabled={busy}><span>⤓</span> Choose File</button>
            </>}
          </div>
          <input ref={fileInput} type="file" accept="video/*,.mkv" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
          <div className="dropzone-or"><span>OR</span></div>
        </>}
        <div className="source-link-field">
          <div className="youtube-fetch-row">
            <span className="yt-link-icon" aria-hidden="true">🔗</span>
            <input id="source-video" aria-label="YouTube link" aria-invalid={Boolean(error)} placeholder="Paste YouTube link here" value={url} onChange={(e) => { setUrl(e.target.value); setLookupUrl(''); setPreview({ status: 'idle' }); setSourceAreas({ facecam: null, gameplay: null }); setAreaTarget(null); setAreaDrag(null); setError(''); }} disabled={busy} />
            <button type="button" className="youtube-search-btn" onClick={() => setLookupUrl(url.trim())} disabled={busy || !isYouTubeUrl(url.trim()) || preview.status === 'loading'}>Search</button>
          </div>
          {!file && <LinkPreview preview={preview} />}
        </div>
        {mode === 'download' && info && (
          <div className="download-video-result" aria-live="polite">
            <img src={info.thumbnail} alt="" />
            <div><strong>{info.title}</strong><span>YouTube · {clockMs(info.duration)}</span></div>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {mode === 'download' && (
          <div className="download-options-panel">
            <div className="download-options-heading"><span>Download options</span><small>{kind === 'video' ? 'Choose video quality' : 'Choose audio format'}</small></div>
            <div className="segmented" role="radiogroup" aria-label="Download type">
              {['video', 'audio'].map((value) => <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)} disabled={busy}>{value === 'video' ? '▶ Video' : '♪ Audio'}</button>)}
            </div>
            {kind === 'video' ? (
              <label className="control-box select"><span>Quality</span><select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={busy}>{qualities.map((h) => <option key={h} value={h}>{h}p{h >= 2160 ? ' 4K' : ''}</option>)}</select></label>
            ) : (
              <label className="control-box select"><span>Format</span><select value={audioFormat} onChange={(e) => setAudioFormat(e.target.value)} disabled={busy}><option value="m4a">M4A (original quality)</option><option value="mp3">MP3 (plays everywhere)</option></select></label>
            )}
            <div className="download-range-fields">
              <label className="control-box"><span>From</span><input type="text" inputMode="numeric" placeholder="0:00" value={downloadFrom} onChange={(e) => setDownloadFrom(e.target.value)} disabled={busy} /></label>
              <label className="control-box"><span>To</span><input type="text" inputMode="numeric" placeholder={info?.duration ? clock(info.duration) : 'End'} value={downloadTo} onChange={(e) => setDownloadTo(e.target.value)} disabled={busy} /></label>
            </div>
            <button className="create-clip-cta" type="submit" disabled={busy}>{buttonLabel} <span>↓</span></button>
          </div>
        )}
      </div>

      {mode === 'clips' && (
        <section className="create-layout-section" aria-labelledby="create-layout-heading">
          <div className="create-layout-heading"><h2 id="create-layout-heading">Choose a {aspectGroup} layout</h2><span>{selectedLayout.label}</span></div>
          <div className="layout-presets create-layout-presets">
            {availableLayouts.map((layout) => (
              <button key={layout.id} type="button" className={`layout-preset${layoutId === layout.id ? ' active' : ''}`} onClick={() => { setLayoutId(layout.id); setAreaTarget(null); if (layout.position) setFacecamPosition(layout.position); setFindFacecam(!['fill', 'game-only', 'blur'].includes(layout.id)); }} disabled={busy} aria-pressed={layoutId === layout.id}>
                <span className={`layout-diagram ${layout.icon}`} aria-hidden="true"><i /><b /></span>
                <strong>{layout.label}</strong><small>{layout.detail}</small>
              </button>
            ))}
          </div>
          {!['fill', 'game-only', 'blur'].includes(layoutId) && (
            <div className="create-facecam-controls">
              <label className="check"><input type="checkbox" checked={findFacecam} onChange={(e) => setFindFacecam(e.target.checked)} disabled={busy} />Find facecam automatically</label>
            </div>
          )}
        </section>
      )}

      {mode !== 'download' && <section className={`studio-stage-grid${mode === 'clips' ? ' with-output-preview' : ''}`}>
        <section className="source-video-panel" aria-label="Source video player">
          {info?.id && !file ? (
            <>
              <div className="youtube-source-player-heading"><strong>{info.title}</strong><span>YouTube · {clockMs(info.duration)}</span></div>
              <iframe
                className="youtube-source-embed"
                src={`https://www.youtube.com/embed/${info.id}?controls=1&playsinline=1&modestbranding=1&rel=0`}
                title={info.title || 'YouTube source player'}
                referrerPolicy="origin"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </>
          ) : fileUrl ? (
            <video src={fileUrl} controls playsInline aria-label="Source video player" />
          ) : (
            <div className="source-video-empty">
              <span className="video-empty-icon" aria-hidden="true">▶</span>
              <strong>Source video</strong>
              <small>Your video will appear here</small>
            </div>
          )}
        </section>
        <div className="preview-player-card scene-selector-card">
          {mode === 'clips' && (
            <div className="source-frame-tools">
              <div className="source-frame-tools-title">
                <strong>Frame selector</strong>
                <small>{areaTarget ? 'Choose a shape, then drag the frame to move or resize it.' : `This layout uses ${frameTargets.length} source frame${frameTargets.length === 1 ? '' : 's'}. Select one to adjust.`}</small>
              </div>
              <div className="source-frame-tool-buttons">
                {frameTargets.map((target) => <button key={target} type="button" className={`btn${areaTarget === target ? ' primary' : ''}`} onClick={() => chooseAreaTarget(target)} disabled={busy || (!fileUrl && !info?.thumbnail)} aria-pressed={areaTarget === target}>
                  <span className={`area-swatch ${target === 'facecam' ? 'camera' : 'gameplay'}`} />{sectionTargets[target]}{sourceAreas[target] ? ' · Set' : ''}
                </button>)}
                <button type="button" className="btn" onClick={() => { setSourceAreas({ facecam: null, gameplay: null }); setAreaTarget(null); }} disabled={busy || (!sourceAreas.facecam && !sourceAreas.gameplay)}>Clear</button>
              </div>
              {areaTarget && <div className="area-shape-options" role="radiogroup" aria-label="Frame shape">
                {validAreaShapes.map((shape) => <label key={shape} className={areaShape === shape ? 'active' : ''}>
                  <input type="radio" name={`source-frame-shape-${areaTarget}`} value={shape} checked={areaShape === shape} onChange={() => chooseAreaShape(shape)} />{shape === 'freeform' ? 'Freeform' : shape === 'circle' ? 'Circle' : shape === 'square' ? 'Square' : shape}
                </label>)}
              </div>}
            </div>
          )}
          <div className="preview-canvas" ref={previewCanvasRef}>
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
              <img className="youtube-scene-still" src={scenePreviewImage} alt={`Scene preview at ${clockMs(scenePreviewTime)}`} />
            ) : (
              <div className="preview-placeholder-scene">
                <span className="empty-preview-art" aria-hidden="true"><i>▶</i></span>
                <strong>Preview your source</strong>
                <p>Paste a YouTube link and click Search, or choose a video file.</p>
              </div>
            )}
            {mode === 'clips' && (fileUrl || info?.thumbnail) && (
              <div
                className={`source-area-layer${areaTarget ? ' selecting' : ''}`}
                onPointerDown={startAreaSelection}
                onPointerMove={moveAreaSelection}
                onPointerUp={finishAreaSelection}
                onPointerCancel={finishAreaSelection}
                aria-label={areaTarget ? `Adjust ${areaTarget} frame on preview` : 'Selected source areas'}
              >
                {frameTargets.map((key) => {
                  const label = sectionTargets[key];
                  const rect = areaDrag?.target === key ? areaDrag.rect : sourceAreas[key];
                  return rect && rect[2] > 0.01 && rect[3] > 0.01 ? (
                    <span key={key} className={`source-area-box ${key}${key === areaTarget ? ` active ${areaShape === 'circle' ? 'circle' : ''}` : ''}`} style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }}>
                      <b>{label}</b>
                      {key === areaTarget && <i className="source-area-resize" aria-hidden="true" />}
                    </span>
                  ) : null;
                })}
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
          {mode === 'clips' && info?.id && !fileUrl && (
            <div className="scene-inspector-controls">
              <label className="scene-time-control">
                <span>{clockMs(scenePreviewTime)}</span>
                <input type="range" min="0" max={Math.max(1, info.duration || 1)} step="1" value={Math.min(scenePreviewTime, info.duration || 0)} onChange={(event) => seekScenePreview(Number(event.target.value))} aria-label="Seek scene preview frame" />
                <span>{clockMs(info.duration)}</span>
              </label>
            </div>
          )}
        </div>

        {mode === 'clips' && (
          <section className="output-preview-section" aria-labelledby="output-preview-heading">
            <div className="output-preview-heading">
              <h2 id="output-preview-heading">Output preview</h2>
              <span>{selectedLayout.label} · {currentAspect === 'custom' ? `${customWidth} × ${customHeight}` : currentAspect}</span>
            </div>
            <div className={`output-preview-stage ${selectedLayout.mode}`} style={{ '--output-aspect': outputAspectRatio }}>
              <div className="output-preview-frame">
                {fileUrl ? (
                  <video ref={outputVideoRef} src={fileUrl} muted playsInline onLoadedMetadata={() => syncOutputPreview()} onTimeUpdate={(e) => { if (videoRef.current && Math.abs(e.currentTarget.currentTime - videoRef.current.currentTime) > 0.35) e.currentTarget.currentTime = videoRef.current.currentTime; }} className="output-preview-video" style={sourceCropStyle(sourceAreas.gameplay)} />
                ) : scenePreviewImage ? <img src={scenePreviewImage} alt="Output composition source" style={sourceCropStyle(sourceAreas.gameplay)} /> : <div className="output-preview-empty"><span className="video-empty-icon" aria-hidden="true">▶</span><strong>Output preview</strong><small>Add a video to see your {currentAspect} composition</small></div>}
                {(fileUrl || info?.thumbnail) && ['split', 'split_flip'].includes(selectedLayout.mode) && <>
                  <span className="output-preview-split camera">{fileUrl ? <video src={fileUrl} muted playsInline style={sourceCropStyle(sourceAreas.facecam)} /> : <img src={scenePreviewImage} alt="" style={sourceCropStyle(sourceAreas.facecam)} />}</span>
                  <span className="output-preview-split gameplay">{fileUrl ? <video src={fileUrl} muted playsInline style={sourceCropStyle(sourceAreas.gameplay)} /> : <img src={scenePreviewImage} alt="" style={sourceCropStyle(sourceAreas.gameplay)} />}</span>
                </>}
                {(fileUrl || info?.thumbnail) && selectedLayout.mode === 'side_by_side' && <>
                  <span className="output-preview-column camera">{fileUrl ? <video src={fileUrl} muted playsInline style={sourceCropStyle(sourceAreas.facecam)} /> : <img src={scenePreviewImage} alt="" style={sourceCropStyle(sourceAreas.facecam)} />}</span>
                  <span className="output-preview-column gameplay">{fileUrl ? <video src={fileUrl} muted playsInline style={sourceCropStyle(sourceAreas.gameplay)} /> : <img src={scenePreviewImage} alt="" style={sourceCropStyle(sourceAreas.gameplay)} />}</span>
                </>}
                {(fileUrl || info?.thumbnail) && selectedLayout.mode === 'pip' && <span className={`output-preview-pip ${selectedLayout.shape === 'circle' ? 'circle' : ''} ${facecamPosition}`}>{fileUrl ? <video src={fileUrl} muted playsInline style={sourceCropStyle(sourceAreas.facecam)} /> : <img src={scenePreviewImage} alt="" style={sourceCropStyle(sourceAreas.facecam)} />}</span>}
                {selectedLayout.mode === 'blur_fill' && <span className="output-preview-blur-label">Blur fill</span>}
              </div>
            </div>
          </section>
        )}

      </section>}

      {mode === 'clips' && <section className="clip-settings-panel" aria-labelledby="clip-settings-heading">
        <div className="clip-settings-section">
          <div className="advanced-grid">
            <label>Clips<select value={clipCount} onChange={(e) => setClipCount(Number(e.target.value))} disabled={busy}>{[3, 5, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            <label>Length<select value={length} onChange={(e) => setLength(e.target.value)} disabled={busy}>{Object.entries(LENGTHS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
            <label>Content<select value={contentType} onChange={(e) => changeContentType(e.target.value)} disabled={busy}>{CONTENT_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>Language<select title="Choose the spoken language for transcription" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>{LANGUAGES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
          <div className="advanced-row wide caption-controls">
            <label className="rights-check"><input type="checkbox" checked={captionsEnabled} onChange={(e) => setCaptionsEnabled(e.target.checked)} disabled={busy} />Add captions</label>
            {captionsEnabled && <CaptionStylePicker value={captionStyle} onChange={setCaptionStyle} disabled={busy} />}
          </div>
        </div>
        <div className="clip-settings-output-row">
        <div className="clip-settings-section clip-output-settings">
            <label className="control-box select">
              <span>Output shape</span>
              <select value={currentAspect} onChange={(e) => setCurrentAspect(e.target.value)} disabled={busy}>
                <option value="original">Original ratio</option>
                {ASPECTS.map(([key]) => <option key={key} value={key}>{key === '9:16' ? 'Vertical' : key === '1:1' ? 'Square' : 'Wide'} · {key}</option>)}
                <option value="custom">Custom dimensions</option>
              </select>
            </label>
            {currentAspect === 'custom' && (
              <div className="custom-frame-fields" aria-label="Custom output frame dimensions">
                <label className="control-box"><span>Width (px)</span><input type="number" min="144" max="4320" step="2" value={customWidth} onChange={(e) => setCustomWidth(Number(e.target.value))} disabled={busy} /></label>
                <span aria-hidden="true">×</span>
                <label className="control-box"><span>Height (px)</span><input type="number" min="144" max="4320" step="2" value={customHeight} onChange={(e) => setCustomHeight(Number(e.target.value))} disabled={busy} /></label>
              </div>
            )}
            <label className="control-box select">
              <span>Resolution</span>
              <select value={outputResolution} onChange={(e) => setOutputResolution(Number(e.target.value))} disabled={busy}>
                <option value={1080}>1080p</option><option value={720}>720p</option>
              </select>
            </label>
            <label className="control-box select">
              <span>Frame rate</span>
              <select value={frameRate} onChange={(e) => setFrameRate(Number(e.target.value))} disabled={busy}>
                <option value={30}>30 fps</option><option value={24}>24 fps</option><option value={60}>60 fps</option>
              </select>
            </label>
        </div>
        <label className="control-box select clip-analysis-range">
          <span>YouTube download + analyze range</span>
          <div className="range-inline">
            <input type="text" placeholder="0:00" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} disabled={busy} />
            <span>to</span>
            <input type="text" placeholder={totalDuration ? clock(totalDuration) : 'end'} value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} disabled={busy} />
          </div>
        </label>
        <div className="clip-settings-actions"><button className="create-clip-cta" type="submit" disabled={busy}>{buttonLabel} <span>→</span></button></div>
        </div>
      </section>}

      {mode === 'cut' && <section className="studio-controls-bar">
        <label className="control-box select"><span>Output shape</span><select value={currentAspect} onChange={(e) => setCurrentAspect(e.target.value)} disabled={busy}><option value="original">Original ratio</option>{ASPECTS.map(([key]) => <option key={key} value={key}>{key}</option>)}</select></label>
        <div className="caption-controls cut-caption-controls">
          <label className="rights-check"><input type="checkbox" checked={captionsEnabled} onChange={(e) => setCaptionsEnabled(e.target.checked)} disabled={busy} />Add captions</label>
          {captionsEnabled && <CaptionStylePicker value={captionStyle} onChange={setCaptionStyle} disabled={busy} />}
        </div>
        <button className="create-clip-cta" type="submit" disabled={busy}>{buttonLabel} <span>→</span></button>
      </section>}
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
