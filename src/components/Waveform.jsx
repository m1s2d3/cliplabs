export default function Waveform({ waveform, from = 0, to, height = 48, className = '' }) {
  if (!waveform?.values?.length) return <div className={`waveform empty ${className}`} style={{ height }} />;
  const { values, interval } = waveform;
  const end = to ?? values.length * interval;
  const first = Math.max(0, Math.floor(from / interval));
  const last = Math.min(values.length, Math.ceil(end / interval));
  const slice = values.slice(first, last);
  const bars = Math.min(slice.length, 400);
  const step = slice.length / Math.max(1, bars);
  const width = 1000;
  let path = '';
  for (let i = 0; i < bars; i += 1) {
    const chunk = slice.slice(Math.floor(i * step), Math.max(Math.floor(i * step) + 1, Math.floor((i + 1) * step)));
    const value = Math.max(0.04, Math.max(...chunk));
    const x = (i / bars) * width;
    const h = value * (height - 4);
    path += `M${x.toFixed(1)} ${((height - h) / 2).toFixed(1)}v${h.toFixed(1)}`;
  }
  return (
    <svg className={`waveform ${className}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <path d={path} strokeWidth={Math.max(1, (width / bars) * 0.6)} />
    </svg>
  );
}
