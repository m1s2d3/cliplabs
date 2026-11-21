import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ASPECTS, CROP_MODES } from '../constants';
import { formatTime } from '../utils';
import CaptionStylePicker from './CaptionStylePicker';
import Waveform from './Waveform';

const MIN_SECONDS = 3;
const MAX_SECONDS = 180;
const round = (value) => Math.round(value * 10) / 10;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const RATIOS = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
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
  const [aspect, setAspect] = useState(clip.aspect || '9:16');
  const [cropMode, setCropMode] = useState(clip.crop_mode || 'center');
  const [cropX, setCropX] = useState(clip.crop_x ?? 0.5);
  const originalLines = useMemo(() => clip.captions.map((g) => ({ start: g.start, end: g.end, text: g.words.map((w) => w.word).join(' ') })), [clip]);
  const [lines, setLines] = useState(originalLines);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState(clip.start);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState(null);
  const transcriptRef = useRef(null);
  const video = useRef(null);
  const previewing = useRef(false);
  const duration = project.duration || clip.end;

  useEffect(() => {
    if (!analysis) api.getAnalysis(project.id).then(setAnalysis).catch(() => setAnalysis({ segments: [], waveform: null }));
  }, [analysis, project.id]);

  const words = useMemo(() => (analysis?.segments || []).flatMap((s) => s.words || []), [analysis]);
  const trimChanged = Math.abs(start - round(clip.start)) > 0.05 || Math.abs(end - round(clip.end)) > 0.05;
  const captionsChanged = lines.some((line, i) => line.text !== originalLines[i]?.text);
  const frameChanged = aspect !== clip.aspect || cropMode !== clip.crop_mode || (cropMode === 'manual' && cropX !== clip.crop_x);
  const styleChanged = captionStyle !== clip.caption_style || captionsEnabled !== clip.captions_enabled;
  const needsRender = trimChanged || captionsChanged || frameChanged || styleChanged;
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
    setAspect(clip.aspect);
    setCropMode(clip.crop_mode);
    setCropX(clip.crop_x ?? 0.5);
    setLines(originalLines);
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
    if (aspect !== clip.aspect) patch.aspect = aspect;
    if (cropMode !== clip.crop_mode) patch.crop_mode = cropMode;
    if (cropMode === 'manual' && cropX !== clip.crop_x) patch.crop_x = cropX;
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      onSaved(await api.updateClip(clip.id, patch));
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
                captionStyle={captionStyle}
                groups={previewGroups}
                current={current}
                playing={playing}
                onToggle={togglePlay}
                onLoaded={() => seek(start)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTime={(t) => !playing && setCurrent(t)}
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
              {[['trim', 'Trim'], ['captions', 'Captions'], ['frame', 'Frame']].map(([key, label]) => (
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
                <label className="field">Format
                  <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                    {ASPECTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    <option value="original">Original</option>
                  </select>
                </label>
                <div className="field">
                  <span>Framing</span>
                  <div className="segmented wrap">
                    {CROP_MODES.map(([key, label]) => <button key={key} type="button" className={cropMode === key ? 'active' : ''} onClick={() => setCropMode(key)} disabled={aspect === 'original'}>{label}</button>)}
                  </div>
                </div>
                {cropMode === 'manual' && aspect !== 'original' && (
                  <label className="field">Position
                    <input type="range" min="0" max="1" step="0.01" value={cropX} onChange={(e) => setCropX(Number(e.target.value))} />
                  </label>
                )}
                <p className="hint">{aspect === 'original' ? 'Keeps the full frame.' : cropMode === 'auto' ? 'Auto follows the speaker’s face. The preview shows the centre position.' : 'The highlighted box shows exactly what will be exported.'}</p>
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={reset} disabled={saving}>Reset changes</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="get-clips" onClick={save} disabled={saving || Boolean(rangeError)}>{saving ? 'Saving…' : needsRender ? 'Save & re-render' : 'Save'} <b>↗</b></button>
        </div>
      </div>
    </div>
  );
}

function PreviewStage({ project, videoRef, aspect, cropMode, cropX, captionStyle, groups, current, onToggle, onLoaded, onPlay, onPause, onTime }) {
  const sourceRatio = project.width && project.height ? project.width / project.height : 16 / 9;
  const ratio = aspect === 'original' ? sourceRatio : RATIOS[aspect];
  const wide = sourceRatio > ratio;
  const boxW = wide ? ratio / sourceRatio : 1;
  const boxH = wide ? 1 : sourceRatio / ratio;
  const position = { center: 0.5, left: 0, right: 1, manual: cropX, auto: 0.5 }[cropMode] ?? 0.5;
  const left = (1 - boxW) * (aspect === 'original' ? 0.5 : position);
  const group = groups.find((g, i) => current >= g.start && current < (groups[i + 1]?.start ?? g.end + 0.35));
  const activeIndex = group ? group.words.findIndex((w, i) => current >= w.start && current < (group.words[i + 1]?.start ?? Infinity)) : -1;
  const upper = captionStyle !== 'minimal';
  const fontCqw = STYLE_SCALE[captionStyle] * 100 * Math.min(1, 1 / ratio);
  const top = (1 - boxH) / 2;
  const pctOf = (value) => `${value * 100}%`;

  return (
    <div className="preview-stage" style={{ aspectRatio: `${sourceRatio}` }}>
      <video ref={videoRef} src={api.url(project.source_media_url)} preload="auto" playsInline onClick={onToggle} onLoadedMetadata={onLoaded} onPlay={onPlay} onPause={onPause} onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)} />
      <div className="crop-shade" style={{ left: 0, top: 0, bottom: 0, width: pctOf(left) }} />
      <div className="crop-shade" style={{ right: 0, top: 0, bottom: 0, width: pctOf(1 - left - boxW) }} />
      <div className="crop-shade" style={{ left: pctOf(left), width: pctOf(boxW), top: 0, height: pctOf(top) }} />
      <div className="crop-shade" style={{ left: pctOf(left), width: pctOf(boxW), bottom: 0, height: pctOf(top) }} />
      <div className="crop-box" style={{ left: pctOf(left), top: pctOf(top), width: pctOf(boxW), height: pctOf(boxH) }}>
        {group && (
          <div className={`live-caption cap-${captionStyle}`} style={{ top: `${STYLE_POSITION[captionStyle]}%`, fontSize: `${fontCqw}cqw` }}>
            {group.words.map((word, index) => {
              const on = captionStyle === 'karaoke' ? index <= activeIndex : index === activeIndex;
              return <span key={index} className={on ? 'on' : ''}>{upper ? word.word.toUpperCase() : word.word}</span>;
            })}
          </div>
        )}
      </div>
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
