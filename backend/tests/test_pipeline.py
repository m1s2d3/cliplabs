import numpy as np
import pytest

from app.pipeline import highlights
from app.pipeline.captions import CaptionRenderer, build_groups, font_for, retime_text
from app.pipeline.download import _clean, validate_youtube_url
from app.pipeline.reframe import _smooth, crop_size, output_size, plan_crop


def words_from(text: str, start: float = 0.0, step: float = 0.35) -> list[dict]:
    return [{"start": round(start + i * step, 3), "end": round(start + i * step + 0.3, 3), "word": w} for i, w in enumerate(text.split())]


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "youtube.com/shorts/abc123",
    "https://m.youtube.com/watch?v=abc",
])
def test_accepts_youtube_urls(url):
    assert validate_youtube_url(url).startswith("https://") or url.startswith("http")


@pytest.mark.parametrize("url", [
    "",
    "https://vimeo.com/123",
    "https://youtube.com.evil.com/watch?v=1",
    "file:///etc/passwd",
    "https://user:pass@youtube.com/watch?v=1",
    "https://youtube.com:8080/watch?v=1",
    "http://127.0.0.1/watch",
])
def test_rejects_non_youtube_urls(url):
    with pytest.raises(ValueError):
        validate_youtube_url(url)


def test_download_errors_are_cleaned():
    raw = Exception("\x1b[0;31mERROR:\x1b[0m [youtube] abc123: This video is unavailable")
    assert _clean(raw) == "This video is unavailable"


def test_sentences_split_on_punctuation_and_gaps():
    words = words_from("Hello there. How are you?") + words_from("Late words", start=10)
    sentences = highlights.build_sentences(words)
    assert [s["text"] for s in sentences] == ["Hello there.", "How are you?", "Late words"]


def test_candidates_respect_length_bounds():
    words = words_from(" ".join(f"Sentence number {i} is here." for i in range(40)))
    sentences = highlights.build_sentences(words)
    candidates = highlights.build_candidates(sentences, 10, 20, words[-1]["end"])
    assert candidates
    assert all(10 <= c["end"] - c["start"] <= 20 for c in candidates)


def test_scoring_prefers_hooks_and_selection_avoids_overlap():
    hooky = words_from("Why does nobody tell you the biggest secret? " + "It is simple and it works every time. " * 3)
    plain = words_from("The weather was fine and we walked home. " * 4, start=hooky[-1]["end"] + 1)
    words = hooky + plain
    energy = np.ones(int(words[-1]["end"] / 0.5) + 1)
    result = highlights.find_highlights(words, [], energy, 0.5, [], words[-1]["end"], 3, 8, 20)
    assert result
    assert "?" in result[0]["first"]
    ordered = sorted(result, key=lambda c: c["start"])
    assert all(a["end"] <= b["start"] for a, b in zip(ordered, ordered[1:]))


def test_select_top_limits_count():
    candidates = [{"start": i * 10.0, "end": i * 10.0 + 5, "score": float(i)} for i in range(10)]
    chosen = highlights.select_top(candidates, 3)
    assert [c["score"] for c in chosen] == [9.0, 8.0, 7.0]


def test_caption_groups_are_short_and_inside_clip():
    words = words_from("this is a longer sentence that should be split into short caption chunks.")
    groups = build_groups(words, 0.5, 3.5)
    assert groups
    assert all(len(g["words"]) <= 3 for g in groups)
    assert all(0.5 <= g["start"] and g["end"] <= 3.5 for g in groups)


def test_retime_text_spans_the_interval():
    words = retime_text(1.0, 3.0, "edited caption text")
    assert [w["word"] for w in words] == ["edited", "caption", "text"]
    assert words[0]["start"] == 1.0 and words[-1]["end"] == 3.0
    assert retime_text(1.0, 3.0, "   ") == []


def test_caption_renderer_highlights_active_word():
    groups = build_groups(words_from("one two three four"), 0, 10)
    renderer = CaptionRenderer(groups, 0, 1080, 1920)
    assert renderer.overlay_at(0.1) is not None
    image, x, y = renderer.overlay_at(0.1)
    assert image.shape[1] == 1080 and image.shape[2] == 4
    assert 0 <= y < 1920 - image.shape[0] + 1
    assert renderer.overlay_at(30) is None


def test_crop_size_is_vertical():
    assert crop_size(1920, 1080) == (608, 1080)
    assert crop_size(1080, 1920) == (1080, 1920)
    w, h = crop_size(1080, 1080)
    assert h == 1080 and w < h


def test_smoothing_ignores_jitter_and_fills_gaps():
    centers = [960, None, 965, 955, 962, 958, None, 961]
    camera = _smooth(centers, 1920, 608)
    assert np.allclose(camera, 960, atol=10)
    assert np.allclose(_smooth([None, None], 1920, 608), 960)


def test_candidates_carry_breakdown_description_and_hashtags():
    words = words_from("Why do startups fail? Founders ignore customers and pricing matters. " * 3)
    energy = np.ones(200)
    clip = highlights.find_highlights(words, [], energy, 0.5, [], words[-1]["end"], 1, 5, 15)[0]
    assert set(clip["breakdown"]) == {"hook", "energy", "pacing", "visuals"}
    assert clip["description"]
    assert clip["hashtags"][-1] == "#shorts"


def test_unreliable_transcript_uses_video_title():
    words = words_from("Be ran a shatchad it's air pain has a harry la. " * 4)
    clip = highlights.find_highlights(words, [], np.ones(200), 0.5, [], words[-1]["end"], 1, 5, 15, video_title="Casa Tupka Anthem", reliable=False)[0]
    assert clip["title"].startswith("Casa Tupka Anthem · ")


def test_music_mode_prefers_loud_chorus():
    segments = [{"start": float(t), "end": t + 2.0, "text": "tarram bum bum" if 40 <= t < 60 else f"verse {t}"} for t in range(0, 100, 4)]
    energy = np.ones(200) * 0.2
    energy[80:120] = 1.0
    picks = highlights.find_highlights([], segments, energy, 0.5, [], 100, 1, 10, 20, content_type="music", video_title="Song")
    assert len(picks) == 1
    assert 30 <= picks[0]["start"] <= 50
    assert picks[0]["title"].startswith("Song · ")


def test_analysis_span_limits_candidates():
    words = words_from("This is a full sentence here. " * 40)
    picks = highlights.find_highlights(words, [], np.ones(400), 0.5, [], words[-1]["end"], 3, 5, 10, span=(10.0, 30.0))
    assert picks and all(10 <= p["start"] and p["end"] <= 30 for p in picks)


@pytest.mark.parametrize("style", ["classic", "highlight", "karaoke", "minimal", "bold"])
def test_every_caption_style_renders(style):
    renderer = CaptionRenderer(build_groups(words_from("one two three"), 0, 5), 0, 1080, 1920, style)
    image, _, _ = renderer.overlay_at(0.4)
    assert image[..., 3].max() > 0


def test_devanagari_uses_indic_font():
    font = font_for("नमस्ते दोस्तो", "heavy", 40)
    assert "Devanagari" in " ".join(font.getname()) or "Unicode" in " ".join(font.getname())


@pytest.mark.parametrize("aspect,expected", [("9:16", (1080, 1920)), ("1:1", (1080, 1080)), ("16:9", (1920, 1080)), ("original", (1920, 1080))])
def test_output_sizes(aspect, expected):
    assert output_size(aspect, 1920, 1080) == expected


def test_fixed_crop_modes_skip_tracking():
    plan = plan_crop(None, 0, 10, 1920, 1080, "9:16", "right")
    assert plan["crop_w"] == 608 and plan["lefts"][0] == 1920 - 608
    assert plan_crop(None, 0, 10, 1920, 1080, "9:16", "manual", 0.0)["lefts"][0] == 0
