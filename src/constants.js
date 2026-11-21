export const MODES = [
  { key: 'clips', label: 'AI Clips', icon: '✦', hint: 'Find the best moments automatically' },
  { key: 'cut', label: 'Manual Cut', icon: '✂', hint: 'Cut an exact time range' },
  { key: 'download', label: 'Download', icon: '↓', hint: 'Save the video or audio' },
];

export const LENGTHS = {
  auto: { label: 'Auto (20–60s)', min_length: 20, max_length: 60 },
  short: { label: 'Short (10–30s)', min_length: 10, max_length: 30 },
  medium: { label: 'Medium (30–60s)', min_length: 30, max_length: 60 },
  long: { label: 'Long (60–90s)', min_length: 60, max_length: 90 },
};

export const LANGUAGES = [
  ['auto', 'Auto-detect'], ['en', 'English'], ['hi', 'Hindi / Hinglish'], ['pa', 'Punjabi'], ['ur', 'Urdu'],
  ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['gu', 'Gujarati'],
  ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['ar', 'Arabic'],
];

export const CONTENT_TYPES = [
  ['talking', 'Talking / podcast'],
  ['music', 'Music video'],
  ['gaming', 'Gaming / stream'],
];

export const ASPECTS = [
  ['9:16', '9:16 Shorts'],
  ['1:1', '1:1 Square'],
  ['16:9', '16:9 Wide'],
];

export const CAPTION_STYLES = [
  { key: 'classic', label: 'Classic', sample: 'IDEA' },
  { key: 'highlight', label: 'Highlight', sample: 'IDEA' },
  { key: 'karaoke', label: 'Karaoke', sample: 'IDEA' },
  { key: 'minimal', label: 'Minimal', sample: 'idea' },
  { key: 'bold', label: 'Bold', sample: 'IDEA' },
];

export const CROP_MODES = [
  ['auto', 'Auto (face)'], ['center', 'Center'], ['left', 'Left'], ['right', 'Right'], ['manual', 'Manual'],
];

export const STATUS_LABELS = {
  queued: 'Queued',
  downloading: 'Downloading',
  transcribing: 'Transcribing',
  analyzing: 'Finding moments',
  rendering: 'Rendering',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const MODE_LABELS = { clips: 'AI clips', cut: 'Manual cut', download: 'Download' };
