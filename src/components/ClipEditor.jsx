import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ASPECTS } from '../constants';
import { formatTime } from '../utils';
import CaptionStylePicker from './CaptionStylePicker';
import Waveform from './Waveform';

const MIN_SECONDS = 3;
const MAX_SECONDS = 180;
const round = (value) => Math.round(value * 10) / 10;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const RATIOS = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
const OUTPUT_SIZES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };
const MULTI_BOX_MODES = ['split', 'split_flip', 'split3', 'pip', 'blur_fill', 'side_by_side'];
const FRAME_SELECTOR_MODES = ['split', 'split_flip', 'split3', 'pip', 'side_by_side'];
const BOX_LABELS = {
  split: ['Top · face', 'Bottom · game'],
  split_flip: ['Top · game', 'Bottom · face'],
  split3: ['Top · face', 'Middle', 'Bottom'],
  side_by_side: ['Camera', 'Gameplay'],
  pip: ['Background', 'Bubble'],
};
const LAYOUT_PRESETS = [
  { id: 'face-game', label: 'Face + gameplay', detail: 'Camera above the action', mode: 'split', icon: 'stack-top' },
  { id: 'game-face', label: 'Gameplay + face', detail: 'Camera below the action', mode: 'split_flip', icon: 'stack-bottom' },
  { id: 'blur', label: 'Blurred fill', detail: 'Keep the complete source', mode: 'blur_fill', icon: 'blur' },
  { id: 'fill', label: 'Fill screen', detail: 'Full-frame centre crop', mode: 'center', icon: 'full' },
  { id: 'game-only', label: 'Gameplay only', detail: 'Crop to the selected area', mode: 'manual', icon: 'full' },
  { id: 'camera-tl', label: 'Camera top-left', detail: 'Square facecam overlay', mode: 'pip', position: 'top_left', shape: 'square', icon: 'pip-tl' },
  { id: 'camera-tr', label: 'Camera top-right', detail: 'Square facecam overlay', mode: 'pip', position: 'top_right', shape: 'square', icon: 'pip-tr' },
  { id: 'camera-bl', label: 'Camera bottom-left', detail: 'Square facecam overlay', mode: 'pip', position: 'bottom_left', shape: 'square', icon: 'pip-bl' },
  { id: 'camera-br', label: 'Camera bottom-right', detail: 'Square facecam overlay', mode: 'pip', position: 'bottom_right', shape: 'square', icon: 'pip-br' },
  { id: 'circle', label: 'Circle camera', detail: 'Round facecam overlay', mode: 'pip', position: 'bottom_right', shape: 'circle', icon: 'circle' },
  { id: 'side', label: 'Side by side', detail: 'Camera and gameplay columns', mode: 'side_by_side', icon: 'columns' },
];

function cropSize(srcW, srcH, aspectRatio, zoom = 1) {
  let w, h;
  if (srcW / srcH > aspectRatio) [w, h] = [Math.min(srcW, Math.round(srcH * aspectRatio / 2) * 2), srcH];
  else [w, h] = [srcW, Math.min(srcH, Math.round(srcW / aspectRatio / 2) * 2)];
  const z = Math.max(0.3, Math.min(1, zoom));
  if (z < 1) [w, h] = [Math.max(2, Math.round(w * z / 2) * 2), Math.max(2, Math.round(h * z / 2) * 2)];
  return [w, h];
}

/** Mirrors backend reframe.plan_band/static_band: a crop window sized to an outW x bandH band, positioned by posFrac (0=left, 1=right). */
function bandBox(srcW, srcH, outW, bandH, posFrac, zoom = 1, yFrac = 0.5) {
  const [w, h] = cropSize(srcW, srcH, outW / bandH, zoom);
  const maxLeft = Math.max(0, srcW - w);
  return { left: (maxLeft * (posFrac ?? 0.5)) / srcW, top: (Math.max(0, srcH - h) * yFrac) / srcH, width: w / srcW, height: h / srcH };
}

/** A starting rectangle (normalized to the full source frame) for a newly chosen shape, mirroring CreatePanel's defaultArea. */
function defaultSourceArea(shape, canvasRatio) {
  const ratio = { square: 1, '9:16': 9 / 16, '16:9': 16 / 9, circle: 1 }[shape];
  let width = shape === 'freeform' ? 0.5 : Math.min(0.62, Math.sqrt(ratio / canvasRatio) * 0.62);
  let height = shape === 'freeform' ? 0.38 : width * canvasRatio / ratio;
  if (height > 0.62) { height = 0.62; width = height * ratio / canvasRatio; }
  return [(1 - width) / 2, (1 - height) / 2, width, height];
}
const STYLE_POSITION = { classic: 70, highlight: 70, karaoke: 72, minimal: 82, bold: 62 };
const STYLE_SCALE = { classic: 0.074, highlight: 0.07, karaoke: 0.07, minimal: 0.052, bold: 0.088 };

/** Mirrors backend caption grouping so the live preview matches the render. */
function buildGroups(words, start, end) {
  const groups = [];
  let current = [];
  for (const word of words) {
    if (word.end <= start || word.start >= end || !word.word.trim()) continue;
    const chars = current.reduce((n, w) => n + w.word.length + 1, 0) + word.word.length;
    if (current.length && (current.length >= 3 || chars > 18 || word.start - current[current.length - 1].end > 0.6)) {
      groups.push(current);
      current = [];
    }
    current.push({ start: Math.max(start, word.start), end: Math.min(end, word.end), word: word.word.trim() });
    if (/[.!?]$/.test(word.word)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups.map((g) => ({ start: g[0].start, end: g[g.length - 1].end, words: g }));
}

function retime(line) {
  const tokens = line.text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, t) => n + t.length + 1, 0) || 1;
  let cursor = line.start;
  const words = tokens.map((token) => {
    const span = ((token.length + 1) / total) * (line.end - line.start);
    const word = { start: cursor, end: cursor + span, word: token };
    cursor += span;
    return word;
  });
  return { start: line.start, end: line.end, words };
}

export default function ClipEditor({ clip, project, analysis: initialAnalysis, onClose, onSaved, notify }) {
  const [analysis, setAnalysis] = useState(initialAnalysis);
  const [tab, setTab] = useState('trim');
  const [title, setTitle] = useState(clip.title);
  const [start, setStart] = useState(round(clip.start));
  const [end, setEnd] = useState(round(clip.end));
  const [captionsEnabled, setCaptionsEnabled] = useState(clip.captions_enabled);
  const [captionStyle, setCaptionStyle] = useState(clip.caption_style || 'classic');
  const [captionPosition, setCaptionPosition] = useState(clip.caption_position ?? null);
  const [aspect, setAspect] = useState(clip.aspect || '9:16');
  const [cropMode, setCropMode] = useState(clip.crop_mode || 'center');
  const [cropX, setCropX] = useState(clip.crop_x ?? null);
  const [cropX2, setCropX2] = useState(clip.crop_x2 ?? 0.5);
  const [cropY, setCropY] = useState(clip.crop_y ?? 0.5);
  const [cropY2, setCropY2] = useState(clip.crop_y2 ?? 0.5);
  const [cropZoom, setCropZoom] = useState(clip.crop_zoom ?? 1);
  const [cropZoom2, setCropZoom2] = useState(clip.crop_zoom2 ?? 1);
  const [pipPosition, setPipPosition] = useState(clip.pip_position || 'bottom_right');
  const [pipShape, setPipShape] = useState(clip.pip_shape || 'circle');
  const [activeBoxIndex, setActiveBoxIndex] = useState(0);
  const [shape1, setShape1] = useState(clip.crop_area ? 'freeform' : 'locked');
  const [shape2, setShape2] = useState(clip.crop_area2 ? 'freeform' : 'locked');
  const [cropArea, setCropArea] = useState(clip.crop_area ?? null);
  const [cropArea2, setCropArea2] = useState(clip.crop_area2 ?? null);
  const [hookEnabled, setHookEnabled] = useState(Boolean(clip.hook_enabled));
  const [hookText, setHookText] = useState(clip.hook || clip.title || '');
  const [hookDuration, setHookDuration] = useState(clip.hook_duration ?? 8);
  const originalLines = useMemo(() => clip.captions.map((g) => ({ start: g.start, end: g.end, text: g.words.map((w) => w.word).join(' ') })), [clip]);
  const [lines, setLines] = useState(originalLines);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState(clip.start);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState(null);
  const [draggingFrame, setDraggingFrame] = useState(false);
  const [draggingCaption, setDraggingCaption] = useState(false);
  const transcriptRef = useRef(null);
  const video = useRef(null);
  const frameDrag = useRef(null);
  const captionDrag = useRef(null);
  const areaDrag = useRef(null);
  const previewing = useRef(false);
  const duration = project.duration || clip.end;

  useEffect(() => {
    if (!analysis) api.getAnalysis(project.id).then(setAnalysis).catch(() => setAnalysis({ segments: [], waveform: null }));
  }, [analysis, project.id]);

  const words = useMemo(() => (analysis?.segments || []).flatMap((s) => s.words || []), [analysis]);
  const trimChanged = Math.abs(start - round(clip.start)) > 0.05 || Math.abs(end - round(clip.end)) > 0.05;
  const captionsChanged = lines.some((line, i) => line.text !== originalLines[i]?.text);
  const DUAL_SLIDER_MODES = ['split', 'split_flip', 'split3', 'side_by_side'];
  const ZOOM_MODES = ['manual', 'split', 'split_flip', 'split3', 'pip'];
  const frameChanged = aspect !== clip.aspect || cropMode !== clip.crop_mode
    || pipPosition !== (clip.pip_position || 'bottom_right') || pipShape !== (clip.pip_shape || 'circle')
    || (cropMode === 'manual' && (cropX !== clip.crop_x || cropY !== clip.crop_y || cropZoom !== clip.crop_zoom))
    || (DUAL_SLIDER_MODES.includes(cropMode) && (cropX !== clip.crop_x || cropX2 !== clip.crop_x2 || cropY !== clip.crop_y || cropY2 !== clip.crop_y2 || cropZoom !== clip.crop_zoom || cropZoom2 !== clip.crop_zoom2))
    || (cropMode === 'pip' && (cropX !== clip.crop_x || cropX2 !== clip.crop_x2 || cropY !== clip.crop_y || cropY2 !== clip.crop_y2 || cropZoom !== clip.crop_zoom || cropZoom2 !== clip.crop_zoom2));
  const styleChanged = captionStyle !== clip.caption_style || captionsEnabled !== clip.captions_enabled || captionPosition !== (clip.caption_position ?? null);
  const hookChanged = hookEnabled !== Boolean(clip.hook_enabled)
    || hookDuration !== (clip.hook_duration ?? 8)
    || hookText !== (clip.hook || clip.title || '');
  const areaChanged = JSON.stringify(cropArea) !== JSON.stringify(clip.crop_area ?? null) || JSON.stringify(cropArea2) !== JSON.stringify(clip.crop_area2 ?? null);
  const needsRender = trimChanged || captionsChanged || frameChanged || areaChanged || styleChanged || hookChanged;
  const selectedLayout = LAYOUT_PRESETS.find((item) => item.mode === cropMode
    && (item.mode !== 'pip' || (item.position === pipPosition && item.shape === pipShape)));
  const aspectGroup = aspect === '9:16' ? 'vertical' : aspect === '16:9' ? 'wide' : aspect === '1:1' ? 'square' : 'original';
  const availableLayouts = LAYOUT_PRESETS.filter((layout) => {
    if (aspectGroup === 'vertical') return layout.mode !== 'side_by_side';
    if (aspectGroup === 'wide') return !['split', 'split_flip'].includes(layout.mode);
    return true;
  });
  const chooseLayout = (layout) => {
    setCropMode(layout.mode);
    if (layout.position) setPipPosition(layout.position);
    if (layout.shape) setPipShape(layout.shape);
    if (aspect === 'original') setAspect('9:16');
    setActiveBoxIndex(0);
  };
  const sourceRatio = project.width && project.height ? project.width / project.height : 16 / 9;
  const secondBandIndex = (BOX_LABELS[cropMode]?.length ?? 1) - 1;
  const chooseShape = (index, shape) => {
    if (index === 0) {
      setShape1(shape);
      if (shape === 'locked') setCropArea(null);
      else if (!cropArea) setCropArea(defaultSourceArea(shape, sourceRatio));
    } else {
      setShape2(shape);
      if (shape === 'locked') setCropArea2(null);
      else if (!cropArea2) setCropArea2(defaultSourceArea(shape, sourceRatio));
    }
  };
  useEffect(() => {
    if (cropMode === 'auto' || availableLayouts.some((layout) => layout.mode === cropMode
      && (layout.mode !== 'pip' || (layout.position === pipPosition && layout.shape === pipShape)))) return;
    const fallback = LAYOUT_PRESETS.find((layout) => layout.id === (aspectGroup === 'wide' ? 'side' : aspectGroup === 'vertical' ? 'face-game' : 'fill'));
    if (fallback) chooseLayout(fallback);
  }, [aspectGroup, cropMode, pipPosition, pipShape]);
  const length = end - start;
  const rangeError = start < 0 || end > duration + 0.05 ? 'Range must be inside the source video' : length < MIN_SECONDS || length > MAX_SECONDS ? `Clips must be ${MIN_SECONDS}–${MAX_SECONDS} seconds` : '';

  const pad = Math.max(15, clip.end - clip.start);
  const windowFrom = Math.max(0, Math.min(clip.start - pad, start - 2));
  const windowTo = Math.min(duration, Math.max(clip.end + pad, end + 2));

  const previewGroups = useMemo(() => {
    if (!captionsEnabled) return [];
    if (trimChanged) return buildGroups(words, start, end);
    return lines.map(retime).filter((g) => g.words.length);
  }, [captionsEnabled, trimChanged, words, start, end, lines]);

  const seek = useCallback((time) => {
    if (video.current) video.current.currentTime = time;
    setCurrent(time);
  }, []);

  const togglePlay = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) {
      if (el.currentTime < start || el.currentTime >= end) el.currentTime = start;
      previewing.current = true;
      el.play();
    } else {
      el.pause();
    }
  }, [start, end]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame;
    const loop = () => {
      const el = video.current;
      if (el) {
        setCurrent(el.currentTime);
        if (previewing.current && el.currentTime >= end) {
          el.pause();
          previewing.current = false;
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, end]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !saving) onClose();
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      const now = video.current?.currentTime ?? current;
      if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'i') {
        setStart(round(Math.min(now, end - MIN_SECONDS)));
      } else if (event.key === 'o') {
        setEnd(round(Math.max(now, start + MIN_SECONDS)));
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = (event.shiftKey ? 5 : 1) * (event.key === 'ArrowLeft' ? -1 : 1);
        seek(clamp(now + step, 0, duration));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving, togglePlay, seek, current, start, end, duration]);

  const setRange = (nextStart, nextEnd) => {
    setStart(round(clamp(nextStart, 0, duration)));
    setEnd(round(clamp(nextEnd, 0, duration)));
  };

  // selectionchange (not mouseup) so touch selection handles work; a collapsed selection is ignored because tapping the button would clear it first.
  useEffect(() => {
    const onSelect = () => {
      const sel = window.getSelection();
      const root = transcriptRef.current;
      if (!sel || sel.isCollapsed || !root || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return;
      const spans = [sel.anchorNode, sel.focusNode].map((node) => (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('[data-start]')).filter(Boolean);
      if (spans.length < 2) return;
      const times = spans.flatMap((span) => [Number(span.dataset.start), Number(span.dataset.end)]);
      setSelection({ start: Math.min(...times), end: Math.max(...times) });
    };
    document.addEventListener('selectionchange', onSelect);
    return () => document.removeEventListener('selectionchange', onSelect);
  }, [tab]);

  const applySelection = () => {
    setRange(selection.start - 0.15, selection.end + 0.3);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    seek(selection.start);
  };

  const reset = () => {
    setTitle(clip.title);
    setRange(clip.start, clip.end);
    setCaptionsEnabled(clip.captions_enabled);
    setCaptionStyle(clip.caption_style);
    setCaptionPosition(clip.caption_position ?? null);
    setAspect(clip.aspect);
    setCropMode(clip.crop_mode);
    setCropX(clip.crop_x ?? null);
    setCropX2(clip.crop_x2 ?? 0.5);
    setCropZoom(clip.crop_zoom ?? 1);
    setCropZoom2(clip.crop_zoom2 ?? 1);
    setPipPosition(clip.pip_position || 'bottom_right');
    setPipShape(clip.pip_shape || 'circle');
    setShape1(clip.crop_area ? 'freeform' : 'locked');
    setShape2(clip.crop_area2 ? 'freeform' : 'locked');
    setCropArea(clip.crop_area ?? null);
    setCropArea2(clip.crop_area2 ?? null);
    setLines(originalLines);
    setHookEnabled(Boolean(clip.hook_enabled));
    setHookText(clip.hook || clip.title || '');
    setHookDuration(clip.hook_duration ?? 8);
  };

  const save = async () => {
    const patch = {};
    if (title.trim() && title.trim() !== clip.title) patch.title = title.trim();
    if (trimChanged) {
      patch.start = start;
      patch.end = end;
    } else if (captionsChanged) {
      patch.captions = lines;
    }
    if (captionsEnabled !== clip.captions_enabled) patch.captions_enabled = captionsEnabled;
    if (captionStyle !== clip.caption_style) patch.caption_style = captionStyle;
    if (captionPosition !== (clip.caption_position ?? null)) patch.caption_position = captionPosition;
    if (aspect !== clip.aspect) patch.aspect = aspect;
    if (cropMode !== clip.crop_mode) patch.crop_mode = cropMode;
    if (cropMode === 'manual') {
      if (cropX !== clip.crop_x) patch.crop_x = cropX;
      if (cropY !== clip.crop_y) patch.crop_y = cropY;
      if (cropZoom !== clip.crop_zoom) patch.crop_zoom = cropZoom;
    }
    if (DUAL_SLIDER_MODES.includes(cropMode)) {
      if (cropX !== clip.crop_x) patch.crop_x = cropX;
      if (cropX2 !== clip.crop_x2) patch.crop_x2 = cropX2;
      if (cropY !== clip.crop_y) patch.crop_y = cropY;
      if (cropY2 !== clip.crop_y2) patch.crop_y2 = cropY2;
      if (cropZoom !== clip.crop_zoom) patch.crop_zoom = cropZoom;
      if (cropZoom2 !== clip.crop_zoom2) patch.crop_zoom2 = cropZoom2;
    }
    if (cropMode === 'pip') {
      if (cropX !== clip.crop_x) patch.crop_x = cropX;
      if (cropX2 !== clip.crop_x2) patch.crop_x2 = cropX2;
      if (cropY !== clip.crop_y) patch.crop_y = cropY;
      if (cropY2 !== clip.crop_y2) patch.crop_y2 = cropY2;
      if (cropZoom !== clip.crop_zoom) patch.crop_zoom = cropZoom;
      if (cropZoom2 !== clip.crop_zoom2) patch.crop_zoom2 = cropZoom2;
    }
    if (pipPosition !== (clip.pip_position || 'bottom_right')) patch.pip_position = pipPosition;
    if (pipShape !== (clip.pip_shape || 'circle')) patch.pip_shape = pipShape;
    if (JSON.stringify(cropArea) !== JSON.stringify(clip.crop_area ?? null)) patch.crop_area = cropArea;
    if (JSON.stringify(cropArea2) !== JSON.stringify(clip.crop_area2 ?? null)) patch.crop_area2 = cropArea2;
    if (hookEnabled !== Boolean(clip.hook_enabled)) patch.hook_enabled = hookEnabled;
    if (Math.abs(hookDuration - (clip.hook_duration ?? 8)) > 0.01) patch.hook_duration = hookDuration;
    if (hookText.trim() !== (clip.hook || '').trim()) patch.hook = hookText.trim();
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const updatedClip = await api.updateClip(clip.id, patch);
      onSaved(updatedClip);
    } catch (err) {
      notify(err.message, 'error');
      setSaving(false);
    }
  };

  const applyFrameToOthers = async () => {
    const frame = {
      aspect,
      crop_mode: cropMode,
      crop_x: cropX,
      crop_x2: cropX2,
      crop_y: cropY,
      crop_y2: cropY2,
      crop_zoom: cropZoom,
      crop_zoom2: cropZoom2,
      crop_area: cropArea,
      crop_area2: cropArea2,
      pip_position: pipPosition,
      pip_shape: pipShape,
    };
    setSaving(true);
    try {
      const updatedClip = await api.updateClip(clip.id, frame);
      const result = await api.applyFrameToOthers(project.id, clip.id, frame);
      onSaved(updatedClip, result.clips);
      notify(result.count ? `Layout queued for ${result.count} other clips` : 'No other ready clips to update');
    } catch (err) {
      notify(err.message, 'error');
      setSaving(false);
    }
  };

  const transcriptWords = words.filter((w) => w.end > windowFrom && w.start < windowTo);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="modal editor-modal" role="dialog" aria-modal="true" aria-label="Edit clip">
        <div className="modal-head">
          <div><p className="kicker">EDIT CLIP</p><h2>{clip.title}</h2></div>
          <div className="head-actions">
            <span className="shortcuts" title="Keyboard shortcuts">Space play · I/O set in/out · ←/→ seek</span>
            <button className="icon-button" onClick={onClose} disabled={saving} aria-label="Close editor">×</button>
          </div>
        </div>
        <div className="editor-grid">
          <div className="editor-preview">
            {project.source_media_url ? (
              <PreviewStage
                project={project}
                videoRef={video}
                aspect={aspect}
                cropMode={cropMode}
                cropX={cropX}
                cropX2={cropX2}
                cropY={cropY}
                cropY2={cropY2}
                cropZoom={cropZoom}
                cropZoom2={cropZoom2}
                shape1={shape1}
                shape2={shape2}
                cropArea={cropArea}
                cropArea2={cropArea2}
                secondBandIndex={secondBandIndex}
                captionStyle={captionStyle}
                captionPosition={captionPosition}
                groups={previewGroups}
                current={current}
                start={start}
                playing={playing}
                activeBoxIndex={activeBoxIndex}
                onSelectBox={setActiveBoxIndex}
                onToggle={togglePlay}
                onLoaded={() => seek(start)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTime={(t) => !playing && setCurrent(t)}
                hookEnabled={hookEnabled}
                hookText={hookText}
                hookDuration={hookDuration}
                draggingCaption={draggingCaption}
                onCaptionDragStart={(event) => {
                  const box = event.currentTarget.closest('.crop-box');
                  if (!box) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  captionDrag.current = box.getBoundingClientRect();
                  setDraggingCaption(true);
                }}
                onAreaDragStart={(event, index) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const bounds = event.currentTarget.closest('.preview-stage').getBoundingClientRect();
                  const rect = index === 0 ? cropArea : cropArea2;
                  areaDrag.current = {
                    index,
                    resizing: Boolean(event.target.closest('.source-area-resize')),
                    startX: (event.clientX - bounds.left) / bounds.width,
                    startY: (event.clientY - bounds.top) / bounds.height,
                    rect,
                  };
                }}
                onFrameDragStart={(event, index, box) => {
                  if (cropMode === 'blur_fill' || (cropMode === 'split3' && index === 1)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  if (cropMode === 'center' || cropMode === 'auto') setCropMode('manual');
                  const second = index === 1;
                  frameDrag.current = {
                    index, resizing: Boolean(event.target.closest('.crop-resize-handle')),
                    startX: event.clientX, startY: event.clientY,
                    width: box.width, height: box.height,
                    initialX: second ? cropX2 : cropX ?? 0.5,
                    initialY: second ? cropY2 : cropY,
                    initialZoom: second ? cropZoom2 : cropZoom,
                  };
                  setDraggingFrame(true);
                }}
                onFrameDrag={(event) => {
                  if (captionDrag.current) {
                    const rect = captionDrag.current;
                    setCaptionPosition(clamp((event.clientY - rect.top) / rect.height, 0.05, 0.95));
                    return;
                  }
                  if (areaDrag.current) {
                    const drag = areaDrag.current;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const x = (event.clientX - bounds.left) / bounds.width;
                    const y = (event.clientY - bounds.top) / bounds.height;
                    const shape = drag.index === 0 ? shape1 : shape2;
                    let rect;
                    if (drag.resizing) {
                      if (shape === 'freeform') {
                        const width = clamp(drag.rect[2] + (x - drag.startX), 0.06, 1 - drag.rect[0]);
                        const height = clamp(drag.rect[3] + (y - drag.startY), 0.06, 1 - drag.rect[1]);
                        rect = [drag.rect[0], drag.rect[1], width, height];
                      } else {
                        const ratio = { square: 1, '9:16': 9 / 16, '16:9': 16 / 9, circle: 1 }[shape];
                        const normalizedRatio = ratio * (bounds.height / bounds.width);
                        const widthDelta = x - drag.startX;
                        const heightDeltaAsWidth = (y - drag.startY) * normalizedRatio;
                        const proposedWidth = drag.rect[2] + (Math.abs(widthDelta) > Math.abs(heightDeltaAsWidth) ? widthDelta : heightDeltaAsWidth);
                        const width = clamp(proposedWidth, 0.06, 1 - drag.rect[0]);
                        rect = [drag.rect[0], drag.rect[1], width, clamp(width / normalizedRatio, 0.06, 1 - drag.rect[1])];
                      }
                    } else {
                      const dx = x - drag.startX, dy = y - drag.startY;
                      rect = [clamp(drag.rect[0] + dx, 0, 1 - drag.rect[2]), clamp(drag.rect[1] + dy, 0, 1 - drag.rect[3]), drag.rect[2], drag.rect[3]];
                    }
                    if (drag.index === 0) setCropArea(rect); else setCropArea2(rect);
                    return;
                  }
                  if (!frameDrag.current) return;
                  const drag = frameDrag.current;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const dx = (event.clientX - drag.startX) / bounds.width;
                  const dy = (event.clientY - drag.startY) / bounds.height;
                  const second = drag.index === 1;
                  if (drag.resizing) {
                    const scale = Math.max(0.35, 1 + Math.max(dx / Math.max(drag.width, 0.05), dy / Math.max(drag.height, 0.05)));
                    const zoom = clamp(drag.initialZoom * scale, 0.3, 1);
                    if (second) setCropZoom2(zoom);
                    else setCropZoom(zoom);
                  } else {
                    const nextX = clamp(drag.initialX + dx / Math.max(0.01, 1 - drag.width), 0, 1);
                    const nextY = clamp(drag.initialY + dy / Math.max(0.01, 1 - drag.height), 0, 1);
                    if (second) { setCropX2(nextX); setCropY2(nextY); }
                    else { setCropX(nextX); setCropY(nextY); }
                  }
                }}
                onFrameDragEnd={() => {
                  if (captionDrag.current) { captionDrag.current = null; setDraggingCaption(false); return; }
                  if (areaDrag.current) { areaDrag.current = null; return; }
                  frameDrag.current = null; setDraggingFrame(false);
                }}
                draggingFrame={draggingFrame}
              />
            ) : (
              <div className="empty">Source video is no longer available.</div>
            )}
            <div className="transport">
              <button className="btn" onClick={togglePlay} disabled={!project.source_media_url}>{playing ? '❚❚ Pause' : '▶ Play clip'}</button>
              <span>{formatTime(current)} <small>/ {formatTime(start)}–{formatTime(end)}</small></span>
              <span className={`length ${rangeError ? 'error-text' : ''}`}>{rangeError || `${length.toFixed(1)}s`}</span>
            </div>
            <Timeline from={windowFrom} to={windowTo} start={start} end={end} current={current} waveform={analysis?.waveform} onChange={setRange} onSeek={seek} />
          </div>

          <div className="editor-fields">
            <div className="editor-tabs" role="tablist">
              {[['trim', 'Trim'], ['captions', 'Captions'], ['frame', 'Frame'], ['hook', 'Hook']].map(([key, label]) => (
                <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
              ))}
            </div>

            {tab === 'trim' && (
              <div className="tab-body">
                <label className="field">Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
                <div className="trim-row">
                  <TimeInput label="Start" value={start} onChange={(v) => { setStart(v); seek(v); }} max={duration} />
                  <TimeInput label="End" value={end} onChange={(v) => { setEnd(v); seek(Math.max(0, v - 2)); }} max={duration} />
                </div>
                <div className="trim-actions">
                  <button type="button" className="btn" onClick={() => setStart(round(current))}>Start = playhead (I)</button>
                  <button type="button" className="btn" onClick={() => setEnd(round(current))}>End = playhead (O)</button>
                </div>
                <div className="transcript-head">
                  <span>Transcript</span>
                  {selection ? <button className="btn primary small" onClick={applySelection}>Use selection ({(selection.end - selection.start).toFixed(1)}s)</button> : <small>Tap a word to jump · select text to set the clip</small>}
                </div>
                <div className="transcript" ref={transcriptRef}>
                  {transcriptWords.length === 0 && <p className="hint">{analysis ? 'No transcript for this part of the video.' : 'Loading transcript…'}</p>}
                  {transcriptWords.map((word, index) => {
                    const inside = word.start >= start - 0.05 && word.end <= end + 0.05;
                    const active = current >= word.start && current < word.end;
                    return (
                      <span key={`${word.start}-${index}`} data-start={word.start} data-end={word.end} className={`${inside ? 'inside' : ''} ${active ? 'active' : ''}`} onClick={() => { if (window.getSelection()?.isCollapsed) { setSelection(null); seek(word.start); } }}>
                        {word.word}{' '}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === 'captions' && (
              <div className="tab-body">
                <label className="check"><input type="checkbox" checked={captionsEnabled} onChange={(e) => setCaptionsEnabled(e.target.checked)} />Burn captions into the video</label>
                <CaptionStylePicker value={captionStyle} onChange={setCaptionStyle} disabled={!captionsEnabled} />
                <p className="hint">Drag the caption on the preview above to move it up or down.</p>
                {captionPosition != null && <button type="button" className="btn small" onClick={() => setCaptionPosition(null)} disabled={!captionsEnabled}>Reset to style default</button>}
                {trimChanged ? (
                  <p className="hint">Captions will be regenerated from the transcript for the new range.</p>
                ) : (
                  <div className="caption-lines">
                    {lines.map((line, index) => (
                      <label key={`${line.start}-${index}`} className={`caption-line ${current >= line.start && current < line.end ? 'current' : ''}`}>
                        <span>{formatTime(line.start - clip.start)}</span>
                        <input value={line.text} maxLength={200} disabled={!captionsEnabled} onFocus={() => seek(line.start)} onChange={(e) => setLines((all) => all.map((l, i) => (i === index ? { ...l, text: e.target.value } : l)))} />
                      </label>
                    ))}
                    {lines.length === 0 && <p className="hint">No speech detected in this range.</p>}
                  </div>
                )}
              </div>
            )}

            {tab === 'frame' && (
              <div className="tab-body">
                <label className="field">Output shape
                  <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                    {ASPECTS.map(([key]) => <option key={key} value={key}>{key === '9:16' ? 'Vertical · 9:16' : key === '1:1' ? 'Square · 1:1' : 'Wide · 16:9'}</option>)}
                    <option value="original">Original ratio</option>
                  </select>
                </label>
                <div className="field">
                  <span>{aspectGroup === 'original' ? 'Layouts' : `${aspectGroup[0].toUpperCase()}${aspectGroup.slice(1)} layouts`}</span>
                  <div className="layout-presets create-layout-presets">
                    {availableLayouts.map((layout) => (
                      <button key={layout.id} type="button" className={`layout-preset${selectedLayout?.id === layout.id ? ' active' : ''}`} onClick={() => chooseLayout(layout)}>
                        <span className={`layout-diagram ${layout.icon}`} aria-hidden="true"><i /><b /></span>
                        <strong>{layout.label}</strong>
                        <small>{layout.detail}</small>
                      </button>
                    ))}
                  </div>
                  </div>
                {FRAME_SELECTOR_MODES.includes(cropMode) && aspect !== 'original' && (
                  <div className="source-frame-tools">
                    <div className="source-frame-tools-title">
                      <strong>Frame selector</strong>
                      <small>Choose a frame, then drag it on the preview to move or resize it.</small>
                    </div>
                    <div className="source-frame-tool-buttons">
                      {BOX_LABELS[cropMode].map((label, i) => (
                        <button key={label} type="button" className={`btn${activeBoxIndex === i ? ' primary' : ''}`} onClick={() => setActiveBoxIndex(i)} aria-pressed={activeBoxIndex === i}>
                          <span className={`area-swatch ${i % 2 ? 'gameplay' : ''}`} />{label}
                        </button>
                      ))}
                    </div>
                    {cropMode === 'pip' && activeBoxIndex === 1 && (
                      <div className="area-shape-options" role="radiogroup" aria-label="Bubble shape">
                        {['circle', 'square'].map((shape) => (
                          <label key={shape} className={pipShape === shape ? 'active' : ''}>
                            <input type="radio" name="pip-bubble-shape" value={shape} checked={pipShape === shape} onChange={() => setPipShape(shape)} />
                            {shape === 'circle' ? 'Circle' : 'Square'}
                          </label>
                        ))}
                      </div>
                    )}
                    {(activeBoxIndex === 0 || activeBoxIndex === secondBandIndex) && (
                      <>
                        <small className="hint">Resize shape · locked follows the drag handle; a shape lets you draw an exact source area.</small>
                        <div className="area-shape-options" role="radiogroup" aria-label="Resize shape">
                          {(cropMode === 'pip' && activeBoxIndex === 1 ? ['locked', 'circle', 'square', 'freeform'] : ['locked', 'square', '9:16', '16:9', 'freeform']).map((shape) => {
                            const current = activeBoxIndex === 0 ? shape1 : shape2;
                            return (
                              <label key={shape} className={current === shape ? 'active' : ''}>
                                <input type="radio" name={`resize-shape-${activeBoxIndex}`} value={shape} checked={current === shape} onChange={() => chooseShape(activeBoxIndex, shape)} />
                                {shape === 'locked' ? 'Locked' : shape === 'freeform' ? 'Freeform' : shape === 'circle' ? 'Circle' : shape === 'square' ? 'Square' : shape}
                              </label>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <button type="button" className="btn editor-auto-face" onClick={() => { setCropX(null); setCropMode('auto'); }}>Find facecam automatically</button>

                <p className="hint">
                    {aspect === 'original' ? 'Keeps the full frame.'
                      : 'Drag a crop frame to reposition it. Drag its lower-right handle to resize.'}
                </p>

              </div>
            )}

            {tab === 'hook' && (
              <div className="tab-body">
                <label className="check"><input type="checkbox" checked={hookEnabled} onChange={(e) => setHookEnabled(e.target.checked)} />Show opening hook</label>
                <label className="field">Hook text
                  <input value={hookText} maxLength={140} disabled={!hookEnabled} onChange={(e) => setHookText(e.target.value)} />
                </label>
                <label className="field">Display duration
                  <input type="range" min="2" max="60" step="1" value={hookDuration} disabled={!hookEnabled} onChange={(e) => setHookDuration(Number(e.target.value))} />
                  <span className="hint">{hookDuration} seconds</span>
                </label>
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={reset} disabled={saving}>Reset changes</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="get-clips" onClick={save} disabled={saving || Boolean(rangeError)}>{saving ? 'Saving…' : needsRender ? 'Save & re-render' : 'Save'} <b>↗</b></button>
          <button className="btn" onClick={applyFrameToOthers} disabled={saving || !['done', 'failed', 'cancelled'].includes(project.status) || Boolean(rangeError)} title="Apply this framing to the other ready clips in this project">Apply frame to others</button>
        </div>
      </div>
    </div>
  );
}

function PreviewStage({ project, videoRef, aspect, cropMode, cropX, cropX2, cropY, cropY2, cropZoom, cropZoom2, shape1, shape2, cropArea, cropArea2, secondBandIndex, captionStyle, captionPosition, groups, current, start, onToggle, onLoaded, onPlay, onPause, onTime, hookEnabled, hookText, hookDuration, onFrameDragStart, onFrameDrag, onFrameDragEnd, draggingFrame, onCaptionDragStart, draggingCaption, onAreaDragStart, activeBoxIndex, onSelectBox }) {
  const sourceRatio = project.width && project.height ? project.width / project.height : 16 / 9;
  const ratio = aspect === 'original' ? sourceRatio : RATIOS[aspect];
  const zoom = Math.max(0.3, Math.min(1, cropMode === 'manual' ? cropZoom ?? 1 : 1));
  const wide = sourceRatio > ratio;
  const boxW = (wide ? ratio / sourceRatio : 1) * zoom;
  const boxH = (wide ? 1 : sourceRatio / ratio) * zoom;
  const position = { center: 0.5, left: 0, right: 1, manual: cropX ?? 0.5, auto: 0.5 }[cropMode] ?? 0.5;
  const left = (1 - boxW) * (aspect === 'original' ? 0.5 : position);
  const group = groups.find((g, i) => current >= g.start && current < (groups[i + 1]?.start ?? g.end + 0.35));
  const activeIndex = group ? group.words.findIndex((w, i) => current >= w.start && current < (group.words[i + 1]?.start ?? Infinity)) : -1;
  const upper = captionStyle !== 'minimal';
  const fontCqw = STYLE_SCALE[captionStyle] * 100 * Math.min(1, 1 / ratio);
  const captionTopPct = captionPosition != null ? captionPosition * 100 : STYLE_POSITION[captionStyle];
  const top = (1 - boxH) * (cropY ?? 0.5);
  const pctOf = (value) => `${value * 100}%`;

  const multiBox = MULTI_BOX_MODES.includes(cropMode) && aspect !== 'original';
  const boxes = useMemo(() => {
    if (!multiBox) return [];
    const [srcW, srcH] = [project.width || 1920, project.height || 1080];
    const [outW, outH] = OUTPUT_SIZES[aspect];
    if (cropMode === 'split') return [
      { ...bandBox(srcW, srcH, outW, outH / 2, cropX, cropZoom, cropY), label: BOX_LABELS.split[0], alt: false },
      { ...bandBox(srcW, srcH, outW, outH / 2, cropX2, cropZoom2, cropY2), label: BOX_LABELS.split[1], alt: true },
    ];
    if (cropMode === 'split_flip') return [
      { ...bandBox(srcW, srcH, outW, outH / 2, cropX2, cropZoom2, cropY2), label: BOX_LABELS.split_flip[0], alt: true },
      { ...bandBox(srcW, srcH, outW, outH / 2, cropX, cropZoom, cropY), label: BOX_LABELS.split_flip[1], alt: false },
    ];
    if (cropMode === 'split3') return [
      { ...bandBox(srcW, srcH, outW, outH / 3, cropX, cropZoom, cropY), label: BOX_LABELS.split3[0], alt: false },
      { ...bandBox(srcW, srcH, outW, outH / 3, 0.5), label: BOX_LABELS.split3[1], alt: true },
      { ...bandBox(srcW, srcH, outW, outH / 3, cropX2, cropZoom2, cropY2), label: BOX_LABELS.split3[2], alt: false },
    ];
    if (cropMode === 'side_by_side') return [
      { ...bandBox(srcW, srcH, outW / 2, outH, cropX, cropZoom, cropY), label: BOX_LABELS.side_by_side[0], alt: false },
      { ...bandBox(srcW, srcH, outW / 2, outH, cropX2, cropZoom2, cropY2), label: BOX_LABELS.side_by_side[1], alt: true },
    ];
    if (cropMode === 'pip') {
      const bubble = Math.round(outW * 0.34);
      return [
        { ...bandBox(srcW, srcH, outW, outH, cropX ?? 0.5, cropZoom, cropY), label: BOX_LABELS.pip[0], alt: false },
        { ...bandBox(srcW, srcH, bubble, bubble, cropX2, cropZoom2, cropY2), label: BOX_LABELS.pip[1], alt: true },
      ];
    }
    if (cropMode === 'blur_fill') return [{ left: 0, top: 0, width: 1, height: 1, label: 'Full frame (blurred fill)', alt: false }];
    return [];
  }, [multiBox, project.width, project.height, aspect, cropMode, cropX, cropX2, cropY, cropY2, cropZoom, cropZoom2]);

  return (
    <div className={`preview-stage${draggingFrame ? ' dragging-frame' : ''}`} style={{ aspectRatio: `${sourceRatio}` }} onPointerMove={onFrameDrag} onPointerUp={onFrameDragEnd} onPointerCancel={onFrameDragEnd}>
      <video ref={videoRef} src={api.url(project.source_media_url)} preload="auto" playsInline onClick={onToggle} onLoadedMetadata={onLoaded} onPlay={onPlay} onPause={onPause} onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)} />
      {hookEnabled && hookText.trim() && current >= start && current - start < hookDuration && (
        <div className="opening-hook-preview" role="status"><span>{hookText.trim()}</span></div>
      )}
      {multiBox ? (
        <>
          <div className="crop-shade-all" />
          {boxes.map((box, i) => {
            const areaShape = i === 0 ? shape1 : i === secondBandIndex ? shape2 : 'locked';
            const area = i === 0 ? cropArea : cropArea2;
            if (areaShape !== 'locked' && area) {
              return (
                <div key={i} className={`source-area-box active${areaShape === 'circle' ? ' circle' : ''}${box.alt ? ' gameplay' : ''}${activeBoxIndex === i ? ' focused' : ''}`} style={{ left: pctOf(area[0]), top: pctOf(area[1]), width: pctOf(area[2]), height: pctOf(area[3]) }} onPointerDown={(event) => { onSelectBox(i); onAreaDragStart(event, i); }}>
                  <b>{box.label}</b><i className="source-area-resize" aria-hidden="true" />
                </div>
              );
            }
            return (
              <div key={i} className={`crop-box draggable${box.alt ? ' alt' : ''}${activeBoxIndex === i ? ' focused' : ''}`} style={{ left: pctOf(box.left), top: pctOf(box.top), width: pctOf(box.width), height: pctOf(box.height) }} onPointerDown={(event) => { onSelectBox(i); onFrameDragStart(event, i, box); }}>
                <span className="crop-box-label">{box.label}</span><i className="crop-resize-handle" aria-hidden="true" />
              </div>
            );
          })}
        </>
      ) : (
        <>
          <div className="crop-shade" style={{ left: 0, top: 0, bottom: 0, width: pctOf(left) }} />
          <div className="crop-shade" style={{ right: 0, top: 0, bottom: 0, width: pctOf(1 - left - boxW) }} />
          <div className="crop-shade" style={{ left: pctOf(left), width: pctOf(boxW), top: 0, height: pctOf(top) }} />
          <div className="crop-shade" style={{ left: pctOf(left), width: pctOf(boxW), bottom: 0, height: pctOf(top) }} />
          <div className={`crop-box${['manual', 'center', 'auto'].includes(cropMode) ? ' draggable' : ''}`} style={{ left: pctOf(left), top: pctOf(top), width: pctOf(boxW), height: pctOf(boxH) }} onPointerDown={['manual', 'center', 'auto'].includes(cropMode) ? (event) => onFrameDragStart(event, 0, { width: boxW }) : undefined}>
            {['manual', 'center', 'auto'].includes(cropMode) && <i className="crop-resize-handle" aria-hidden="true" />}
            {group && (
              <div
                className={`live-caption cap-${captionStyle}${draggingCaption ? ' dragging' : ''}`}
                style={{ top: `${captionTopPct}%`, fontSize: `${fontCqw}cqw` }}
                onPointerDown={onCaptionDragStart}
              >
                {group.words.map((word, index) => {
                  const on = captionStyle === 'karaoke' ? index <= activeIndex : index === activeIndex;
                  return <span key={index} className={on ? 'on' : ''}>{upper ? word.word.toUpperCase() : word.word}</span>;
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Timeline({ from, to, start, end, current, waveform, onChange, onSeek }) {
  const track = useRef(null);
  const span = Math.max(0.1, to - from);
  const pct = (t) => `${clamp(((t - from) / span) * 100, 0, 100)}%`;
  const timeAt = (clientX) => {
    const rect = track.current.getBoundingClientRect();
    return from + clamp((clientX - rect.left) / rect.width, 0, 1) * span;
  };

  const drag = (kind) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    const origin = timeAt(event.clientX);
    const initial = { start, end };
    const move = (e) => {
      const t = timeAt(e.clientX);
      if (kind === 'start') onChange(Math.min(t, initial.end - MIN_SECONDS), initial.end);
      else if (kind === 'end') onChange(initial.start, Math.max(t, initial.start + MIN_SECONDS));
      else {
        const shift = clamp(t - origin, from - initial.start, to - initial.end);
        onChange(initial.start + shift, initial.end + shift);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="editor-timeline">
      <div className="track" ref={track} onPointerDown={(e) => onSeek(timeAt(e.clientX))}>
        <Waveform waveform={waveform} from={from} to={to} height={56} />
        <div className="selection" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} onPointerDown={drag('move')}>
          <span className="handle start" onPointerDown={drag('start')} aria-label="Drag to change start" />
          <span className="handle end" onPointerDown={drag('end')} aria-label="Drag to change end" />
        </div>
        <div className="playhead" style={{ left: pct(current) }} />
      </div>
      <div className="timeline-labels"><span>{formatTime(from)}</span><span>{formatTime((from + to) / 2)}</span><span>{formatTime(to)}</span></div>
    </div>
  );
}

function TimeInput({ label, value, onChange, max }) {
  return (
    <label className="time-input">
      <span>{label}</span>
      <div>
        <button type="button" onClick={() => onChange(round(Math.max(0, value - 1)))} aria-label={`${label} minus one second`}>−</button>
        <input type="number" step="0.1" min="0" max={max} value={value} onChange={(e) => onChange(round(Number(e.target.value) || 0))} />
        <button type="button" onClick={() => onChange(round(Math.min(max, value + 1)))} aria-label={`${label} plus one second`}>+</button>
      </div>
    </label>
  );
}
