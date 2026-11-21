import bisect
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .. import config

FONT_FALLBACKS = (
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)


def build_groups(words: list[dict], start: float, end: float, max_words: int = 3, max_chars: int = 18, max_gap: float = 0.6) -> list[dict]:
    """Groups transcript words inside [start, end] into short on-screen caption chunks (absolute times)."""
    inside = [w for w in words if w["end"] > start and w["start"] < end]
    groups, current = [], []
    for word in inside:
        text = word["word"].strip()
        if not text:
            continue
        chars = sum(len(w["word"]) + 1 for w in current) + len(text)
        if current and (len(current) >= max_words or chars > max_chars or word["start"] - current[-1]["end"] > max_gap):
            groups.append(current)
            current = []
        current.append({"start": max(start, word["start"]), "end": min(end, word["end"]), "word": text})
        if re.search(r"[.!?]$", text):
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    return [{"start": g[0]["start"], "end": g[-1]["end"], "words": g} for g in groups]


def retime_text(start: float, end: float, text: str) -> list[dict]:
    """Spreads edited caption text across a group's time span, weighted by word length."""
    tokens = text.split()
    if not tokens or end <= start:
        return []
    weights = np.array([len(t) + 1 for t in tokens], dtype=float)
    edges = start + np.concatenate([[0], np.cumsum(weights)]) / weights.sum() * (end - start)
    return [{"start": round(float(edges[i]), 3), "end": round(float(edges[i + 1]), 3), "word": t} for i, t in enumerate(tokens)]


UNICODE_FALLBACK = ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0)
LATIN_FONTS = {
    "heavy": (config.CAPTION_FONT, 0),
    "regular": ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    "impact": ("/System/Library/Fonts/Supplemental/Impact.ttf", 0),
}
# (first codepoint, last codepoint, font file, face index of a bold weight)
SCRIPT_FONTS = (
    (0x0900, 0x097F, "/System/Library/Fonts/Kohinoor.ttc", 3),
    (0x0980, 0x09FF, "/System/Library/Fonts/KohinoorBangla.ttc", 3),
    (0x0A00, 0x0A7F, "/System/Library/Fonts/MuktaMahee.ttc", 6),
    (0x0A80, 0x0AFF, "/System/Library/Fonts/KohinoorGujarati.ttc", 3),
    (0x0B80, 0x0BFF, "/System/Library/Fonts/Supplemental/Tamil Sangam MN.ttc", 0),
    (0x0C00, 0x0C7F, "/System/Library/Fonts/KohinoorTelugu.ttc", 3),
    (0x0600, 0x06FF, "/System/Library/Fonts/NotoNastaliq.ttc", 0),
)

STYLES = {
    "classic": {"font": "heavy", "scale": 0.074, "upper": True, "text": (255, 255, 255), "active": (216, 245, 106), "mode": "color", "position": 0.70},
    "highlight": {"font": "heavy", "scale": 0.07, "upper": True, "text": (255, 255, 255), "active": (19, 24, 25), "box": (216, 245, 106), "mode": "box", "position": 0.70},
    "karaoke": {"font": "heavy", "scale": 0.07, "upper": True, "text": (255, 255, 255), "active": (255, 214, 64), "mode": "sweep", "position": 0.72},
    "minimal": {"font": "regular", "scale": 0.052, "upper": False, "text": (255, 255, 255), "active": None, "mode": "plain", "position": 0.82, "backdrop": (0, 0, 0, 150)},
    "bold": {"font": "impact", "scale": 0.088, "upper": True, "text": (255, 225, 77), "active": (255, 255, 255), "mode": "color", "position": 0.62},
}


@lru_cache(maxsize=32)
def _load(path: str, index: int, size: int) -> ImageFont.FreeTypeFont:
    for candidate, face in ((path, index), (path, 0), UNICODE_FALLBACK, *((p, 0) for p in FONT_FALLBACKS)):
        if candidate and Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size, index=face)
            except OSError:
                continue
    return ImageFont.load_default(size)


def font_for(text: str, kind: str, size: int) -> ImageFont.FreeTypeFont:
    for char in text:
        code = ord(char)
        if code > 0x024F:
            for first, last, path, index in SCRIPT_FONTS:
                if first <= code <= last:
                    return _load(path, index, size)
            return _load(*UNICODE_FALLBACK, size)
    path, index = LATIN_FONTS.get(kind, LATIN_FONTS["heavy"])
    return _load(path, index, size)


class CaptionRenderer:
    """Pre-renders caption overlays and returns the right one for any timestamp in the clip."""

    def __init__(self, groups: list[dict], clip_start: float, width: int, height: int, style: str = "classic"):
        self.width, self.height = width, height
        self.style = STYLES.get(style, STYLES["classic"])
        self.size = int(min(width, height) * self.style["scale"])
        self.stroke = max(3, int(self.size * 0.11)) if self.style["mode"] != "plain" else 0
        self.center_y = int(height * self.style["position"])
        self.events: list[tuple[float, float, int, int]] = []
        transform = str.upper if self.style["upper"] else str
        self.groups = [[transform(w["word"]) for w in g["words"]] for g in groups]
        self._cache: dict[tuple[int, int], tuple[np.ndarray, int, int]] = {}

        for gi, group in enumerate(groups):
            words = group["words"]
            next_start = groups[gi + 1]["start"] - clip_start if gi + 1 < len(groups) else None
            group_end = words[-1]["end"] - clip_start + 0.35
            if next_start is not None:
                group_end = max(words[-1]["end"] - clip_start, min(group_end, next_start))
            for wi, word in enumerate(words):
                t0 = word["start"] - clip_start
                t1 = words[wi + 1]["start"] - clip_start if wi + 1 < len(words) else group_end
                if t1 > t0:
                    self.events.append((t0, t1, gi, wi))
        self.events.sort()
        self._starts = [e[0] for e in self.events]

    def overlay_at(self, t: float) -> tuple[np.ndarray, int, int] | None:
        i = bisect.bisect_right(self._starts, t) - 1
        if i < 0 or t >= self.events[i][1]:
            return None
        _, _, gi, wi = self.events[i]
        key = (gi, -1 if self.style["mode"] == "plain" else wi)
        if key not in self._cache:
            self._cache[key] = self._draw(self.groups[gi], wi)
        return self._cache[key]

    def _word_color(self, index: int, active: int) -> tuple:
        mode, style = self.style["mode"], self.style
        if mode == "color" and index == active:
            return style["active"]
        if mode == "sweep" and index <= active:
            return style["active"]
        if mode == "box" and index == active:
            return style["active"]
        return style["text"]

    def _draw(self, words: list[str], active: int) -> tuple[np.ndarray, int, int]:
        font = font_for(" ".join(words), self.style["font"], self.size)
        space = font.getlength(" ")
        max_width = self.width * 0.86
        lines, line, line_w = [], [], 0.0
        for i, word in enumerate(words):
            w = font.getlength(word)
            if line and line_w + space + w > max_width:
                lines.append((line, line_w))
                line, line_w = [], 0.0
            line_w += (space if line else 0) + w
            line.append((i, word, w))
        lines.append((line, line_w))

        ascent, descent = font.getmetrics()
        line_h = ascent + descent
        pad = max(self.stroke * 3, int(self.size * 0.3))
        box_h = line_h * len(lines) + pad * 2
        image = Image.new("RGBA", (self.width, box_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        if self.style.get("backdrop"):
            widest = max(total for _, total in lines)
            left = (self.width - widest) / 2 - pad
            draw.rounded_rectangle((left, pad * 0.4, left + widest + pad * 2, box_h - pad * 0.4), radius=int(self.size * 0.35), fill=self.style["backdrop"])
        for li, (items, total) in enumerate(lines):
            x = (self.width - total) / 2
            y = pad + li * line_h
            for index, word, w in items:
                if self.style["mode"] == "box" and index == active:
                    inset = self.size * 0.12
                    draw.rounded_rectangle((x - inset * 1.5, y - inset * 0.3, x + w + inset * 1.5, y + line_h - inset * 0.6), radius=int(self.size * 0.2), fill=self.style["box"])
                    draw.text((x, y), word, font=font, fill=self.style["active"])
                else:
                    if self.stroke:
                        draw.text((x + 4, y + 6), word, font=font, fill=(0, 0, 0, 110), stroke_width=self.stroke, stroke_fill=(0, 0, 0, 110))
                    draw.text((x, y), word, font=font, fill=self._word_color(index, active), stroke_width=self.stroke, stroke_fill=(0, 0, 0))
                x += w + space
        top = max(0, min(self.height - box_h, self.center_y - box_h // 2))
        return np.asarray(image), 0, top


def blend(frame: np.ndarray, overlay: np.ndarray, x: int, y: int) -> None:
    h, w = overlay.shape[:2]
    region = frame[y:y + h, x:x + w]
    alpha = overlay[..., 3:4].astype(np.float32) / 255.0
    region[:] = (region * (1 - alpha) + overlay[..., :3] * alpha).astype(np.uint8)
