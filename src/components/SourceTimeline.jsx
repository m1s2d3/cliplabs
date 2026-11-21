import { clock } from '../utils';
import Waveform from './Waveform';

export default function SourceTimeline({ duration, clips, waveform, onOpen, range }) {
  if (!duration) return null;
  const pct = (t) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  return (
    <section className="source-timeline" aria-label="Where clips come from in the source video">
      <div className="timeline-track">
        <Waveform waveform={waveform} to={duration} height={44} />
        {range && <div className="timeline-range" style={{ left: pct(range[0]), width: pct(range[1] - range[0]) }} />}
        {clips.map((clip, index) => (
          <button
            key={clip.id}
            className={`timeline-marker ${clip.status === 'ready' ? '' : 'pending'}`}
            style={{ left: pct(clip.start), width: pct(clip.end - clip.start) }}
            onClick={() => clip.status === 'ready' && onOpen(clip.id)}
            title={`#${index + 1} ${clip.title} (${clock(clip.start)}–${clock(clip.end)})`}
            aria-label={`Clip ${index + 1}: ${clip.title}`}
          >
            <span>{index + 1}</span>
          </button>
        ))}
      </div>
      <div className="timeline-labels"><span>0:00</span><span>{clock(duration / 2)}</span><span>{clock(duration)}</span></div>
    </section>
  );
}
