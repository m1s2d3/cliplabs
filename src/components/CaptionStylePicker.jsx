import { CAPTION_STYLES } from '../constants';

export default function CaptionStylePicker({ value, onChange, disabled }) {
  return (
    <div className="style-picker" role="radiogroup" aria-label="Caption style">
      {CAPTION_STYLES.map((style) => (
        <button
          key={style.key}
          type="button"
          role="radio"
          aria-checked={value === style.key}
          className={`style-chip style-${style.key} ${value === style.key ? 'active' : ''}`}
          onClick={() => onChange(style.key)}
          disabled={disabled}
        >
          <span className="style-sample">{style.key === 'minimal' ? 'the ' : 'THE '}<b>{style.sample}</b></span>
          <small>{style.label}</small>
        </button>
      ))}
    </div>
  );
}
