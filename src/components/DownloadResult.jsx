import { api } from '../api';
import { clock, formatBytes } from '../utils';

export default function DownloadResult({ project }) {
  const audio = ['m4a', 'mp3'].includes(project.output_kind);
  return (
    <section className="download-result">
      <div className="download-media">
        {project.output_url && (audio ? (
          <div className="audio-card">
            {project.thumbnail && <img src={api.url(project.thumbnail)} alt="" referrerPolicy="no-referrer" />}
            <audio src={api.url(project.output_url)} controls preload="metadata" />
          </div>
        ) : (
          <video src={api.url(project.output_url)} poster={api.url(project.thumbnail) || undefined} controls preload="metadata" playsInline />
        ))}
      </div>
      <div className="download-info">
        <p className="kicker">{audio ? 'AUDIO' : 'VIDEO'} · {project.output_kind?.toUpperCase()}</p>
        <h2>{project.title}</h2>
        <dl>
          <div><dt>Channel</dt><dd>{project.channel || '—'}</dd></div>
          <div><dt>Length</dt><dd>{clock(project.duration)}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(project.output_size)}</dd></div>
          {!audio && <div><dt>Quality</dt><dd>{project.options.quality === 'best' ? 'Best' : `${project.options.quality}p max`}</dd></div>}
        </dl>
        <a className="get-clips" href={api.fileUrl(project.id)} download>Download {audio ? 'audio' : 'video'} <b>↓</b></a>
      </div>
    </section>
  );
}
