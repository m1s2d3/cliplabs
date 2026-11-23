import subprocess
import tempfile
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .. import config
from .captions import CaptionRenderer, blend
from .media import PipelineError
from .reframe import output_size, plan_area, plan_crop, plan_pip, plan_side_by_side, plan_split, plan_split3


def _band_crop(frame: np.ndarray, plan: dict, t: float) -> np.ndarray:
    """Crops a frame to a band plan; bands with a tracked "times" axis follow it, static bands use a fixed left."""
    left = int(round(np.interp(t, plan["times"], plan["lefts"]))) if "times" in plan else plan["left"]
    return frame[plan["top"]:plan["top"] + plan["crop_h"], left:left + plan["crop_w"]]


def _blur_fill(frame: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """Letterboxes the frame to fit out_w x out_h, filling the bars with a blurred, cropped copy of itself."""
    src_h, src_w = frame.shape[:2]
    scale = min(out_w / src_w, out_h / src_h)
    fit_w, fit_h = int(src_w * scale) // 2 * 2 or 2, int(src_h * scale) // 2 * 2 or 2
    fitted = cv2.resize(frame, (fit_w, fit_h), interpolation=cv2.INTER_LINEAR)

    cover_scale = max(out_w / src_w, out_h / src_h)
    cover = cv2.resize(frame, (int(src_w * cover_scale), int(src_h * cover_scale)), interpolation=cv2.INTER_LINEAR)
    cy, cx = (cover.shape[0] - out_h) // 2, (cover.shape[1] - out_w) // 2
    background = cv2.GaussianBlur(cover[cy:cy + out_h, cx:cx + out_w], (0, 0), sigmaX=25)

    out = background.copy()
    y, x = (out_h - fit_h) // 2, (out_w - fit_w) // 2
    out[y:y + fit_h, x:x + fit_w] = fitted
    return out


def _round_mask(size: int) -> np.ndarray:
    yy, xx = np.ogrid[:size, :size]
    center = (size - 1) / 2
    return ((xx - center) ** 2 + (yy - center) ** 2) <= (size / 2) ** 2


def _opening_hook(frame: np.ndarray, text: str, duration: float, t: float) -> np.ndarray:
    """Draw a readable curiosity hook over the first seconds of a clip."""
    if not text or t >= duration:
        return frame
    h, w = frame.shape[:2]
    margin = max(24, int(w * 0.055))
    max_width = w - margin * 2
    font_size = max(28, int(w * 0.055))
    font_path = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
    font = ImageFont.truetype(font_path, font_size) if Path(font_path).exists() else ImageFont.load_default(font_size)

    words = text.strip().split()
    lines, line = [], []
    for word in words:
        candidate = " ".join([*line, word])
        if font.getbbox(candidate)[2] <= max_width or not line:
            line.append(word)
        else:
            lines.append(" ".join(line)); line = [word]
    if line:
        lines.append(" ".join(line))
    lines = lines[:3]

    line_height = font_size + 10
    box_h = len(lines) * line_height + 34
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    top = max(margin, int(h * 0.08))
    draw.rounded_rectangle((margin, top, w - margin, top + box_h), radius=max(12, int(w * 0.02)), fill=(0, 0, 0, 190))
    y = top + 17
    for line_text in lines:
        bbox = draw.textbbox((0, 0), line_text, font=font)
        draw.text(((w - (bbox[2] - bbox[0])) / 2, y), line_text, font=font, fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
        y += line_height
    return np.array(Image.alpha_composite(Image.fromarray(frame).convert("RGBA"), canvas).convert("RGB"))


def render_clip(
    source: Path,
    out_dir: Path,
    clip_id: str,
    start: float,
    end: float,
    src_w: int,
    src_h: int,
    has_audio: bool,
    caption_groups: list[dict] | None,
    on_progress: Callable[[float], None] = lambda _: None,
    aspect: str = "9:16",
    caption_style: str = "classic",
    crop_mode: str = "auto",
    crop_x: float | None = None,
    crop_x2: float | None = None,
    crop_y: float | None = None,
    crop_y2: float | None = None,
    crop_zoom: float | None = None,
    crop_zoom2: float | None = None,
    hook_text: str | None = None,
    hook_duration: float = 8.0,
    resolution: int = 1080,
    output_fps: int = 30,
    pip_position: str = "bottom_right",
    pip_shape: str = "circle",
    camera_area: tuple[float, float, float, float] | None = None,
    gameplay_area: tuple[float, float, float, float] | None = None,
) -> tuple[Path, Path]:
    """Decodes the source span, applies the crop and captions per frame, and encodes an MP4."""
    out_dir.mkdir(parents=True, exist_ok=True)
    duration = end - start
    fps = output_fps or config.OUTPUT_FPS
    zoom, zoom2 = crop_zoom or 1.0, crop_zoom2 or 1.0
    split3 = crop_mode == "split3" and aspect != "original"
    split = crop_mode in ("split", "split_flip") and aspect != "original"
    pip = crop_mode == "pip" and aspect != "original"
    blur_fill = crop_mode == "blur_fill" and aspect != "original"
    side_by_side = crop_mode == "side_by_side" and aspect != "original"
    if split3:
        out_w, out_h = output_size(aspect, src_w, src_h, resolution)
        band_h = out_h // 3
        bands = plan_split3(source, start, end, src_w, src_h, out_w, band_h, crop_x, crop_x2, zoom, zoom2, camera_area, gameplay_area, crop_y, crop_y2)
    elif split:
        out_w, out_h = output_size(aspect, src_w, src_h, resolution)
        half_h = out_h // 2
        bands = plan_split(source, start, end, src_w, src_h, out_w, half_h, crop_x, crop_x2, flip=crop_mode == "split_flip", zoom=zoom, zoom2=zoom2, camera_area=camera_area, gameplay_area=gameplay_area, crop_y=crop_y, crop_y2=crop_y2)
    elif side_by_side:
        out_w, out_h = output_size(aspect, src_w, src_h, resolution)
        bands = plan_side_by_side(source, start, end, src_w, src_h, out_w, out_h, crop_x, crop_x2, zoom, zoom2, camera_area, gameplay_area, crop_y, crop_y2)
    elif pip:
        out_w, out_h = output_size(aspect, src_w, src_h, resolution)
        pip_plan = plan_pip(source, start, end, src_w, src_h, aspect, out_w, out_h, crop_mode, crop_x, zoom, camera_area, gameplay_area, crop_x2=crop_x2, crop_y=crop_y, crop_y2=crop_y2, zoom2=zoom2)
        bubble_size, mask = pip_plan["bubble_size"], None
    elif blur_fill:
        out_w, out_h = output_size(aspect, src_w, src_h, resolution)
    else:
        plan = plan_crop(source, start, end, src_w, src_h, aspect, crop_mode, crop_x, zoom, gameplay_area or camera_area, crop_y)
        crop_w, crop_h, top, times, lefts = plan["crop_w"], plan["crop_h"], plan["top"], plan["times"], plan["lefts"]
        out_w, out_h = output_size(aspect, crop_w, crop_h, resolution)
    captions = CaptionRenderer(caption_groups, start, out_w, out_h, caption_style) if caption_groups else None



    video_path = out_dir / f"{clip_id}.mp4"
    thumb_path = out_dir / f"{clip_id}.jpg"
    tmp_path = out_dir / f"{clip_id}.rendering.mp4"
    total_frames = max(1, int(round(duration * fps)))
    frame_bytes = src_w * src_h * 3

    decode_cmd = [
        "ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(source), "-t", f"{duration:.3f}",
        "-an", "-vf", f"fps={fps},scale={src_w}:{src_h}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ]
    encode_cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}", "-r", str(fps), "-i", "-",
    ]
    if has_audio:
        encode_cmd += ["-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(source), "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "160k"]
    encode_cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest", str(tmp_path)]

    with tempfile.TemporaryFile() as decode_err, tempfile.TemporaryFile() as encode_err:
        decoder = subprocess.Popen(decode_cmd, stdout=subprocess.PIPE, stderr=decode_err)
        encoder = subprocess.Popen(encode_cmd, stdin=subprocess.PIPE, stderr=encode_err)
        thumb_frame, index = None, 0
        try:
            while True:
                raw = decoder.stdout.read(frame_bytes)
                if len(raw) < frame_bytes:
                    break
                frame = np.frombuffer(raw, dtype=np.uint8).reshape(src_h, src_w, 3)
                t = index / fps
                if split3:
                    band_h = out_h // 3
                    out = np.vstack([
                        cv2.resize(_band_crop(frame, bands[key], t), (out_w, band_h), interpolation=cv2.INTER_LINEAR)
                        for key in ("top", "middle", "bottom")
                    ])
                elif split:
                    half_h = out_h // 2
                    out = np.vstack([
                        cv2.resize(_band_crop(frame, bands[key], t), (out_w, half_h), interpolation=cv2.INTER_LINEAR)
                        for key in ("top", "bottom")
                    ])
                elif side_by_side:
                    half_w = out_w // 2
                    out = np.hstack([
                        cv2.resize(_band_crop(frame, bands[key], t), (half_w, out_h), interpolation=cv2.INTER_LINEAR)
                        for key in ("left", "right")
                    ])
                elif pip:
                    bg_plan = pip_plan["background"]
                    bg_left = int(round(np.interp(t, bg_plan["times"], bg_plan["lefts"])))
                    bg_crop = frame[bg_plan["top"]:bg_plan["top"] + bg_plan["crop_h"], bg_left:bg_left + bg_plan["crop_w"]]
                    out = cv2.resize(bg_crop, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
                    bubble = cv2.resize(_band_crop(frame, pip_plan["bubble"], t), (bubble_size, bubble_size), interpolation=cv2.INTER_LINEAR)
                    if pip_shape == "circle" and mask is None:
                        mask = _round_mask(bubble_size)
                    margin = int(round(out_w * 0.04))
                    by = margin if pip_position.startswith("top") else out_h - margin - bubble_size
                    bx = margin if pip_position.endswith("left") else out_w - margin - bubble_size
                    region = out[by:by + bubble_size, bx:bx + bubble_size]
                    if pip_shape == "circle":
                        region[mask] = bubble[mask]
                    else:
                        region[:] = bubble
                elif blur_fill:
                    selected = frame
                    if gameplay_area or camera_area:
                        area_plan = plan_area(src_w, src_h, out_w, out_h, gameplay_area or camera_area)
                        selected = frame[area_plan["top"]:area_plan["top"] + area_plan["crop_h"], area_plan["left"]:area_plan["left"] + area_plan["crop_w"]]
                    out = _blur_fill(selected, out_w, out_h)
                else:
                    left = int(round(np.interp(t, times, lefts)))
                    cropped = frame[top:top + crop_h, left:left + crop_w]
                    out = cv2.resize(cropped, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
                if hook_text:
                    out = _opening_hook(out, hook_text, hook_duration, t)
                if captions:
                    overlay = captions.overlay_at(t)
                    if overlay is not None:
                        blend(out, *overlay)
                if thumb_frame is None and t >= min(1.0, duration / 2):
                    thumb_frame = out.copy()
                encoder.stdin.write(out.tobytes())
                index += 1
                if index % 15 == 0:
                    on_progress(min(1.0, index / total_frames))
        except BrokenPipeError:
            pass
        except BaseException:
            decoder.kill()
            encoder.kill()
            tmp_path.unlink(missing_ok=True)
            raise
        finally:
            if encoder.stdin and not encoder.stdin.closed:
                try:
                    encoder.stdin.close()
                except BrokenPipeError:
                    pass
            decoder.stdout.close()
            decoder.wait()
            encoder.wait()
        if encoder.returncode != 0 or index == 0:
            encode_err.seek(0)
            decode_err.seek(0)
            detail = (encode_err.read() or decode_err.read()).decode(errors="ignore").strip().splitlines()[-3:]
            tmp_path.unlink(missing_ok=True)
            raise PipelineError("Rendering failed: " + (" ".join(detail) or "no frames decoded"))

    tmp_path.replace(video_path)
    if thumb_frame is not None:
        Image.fromarray(thumb_frame).resize((360, int(360 * out_h / out_w) // 2 * 2)).save(thumb_path, quality=85)
    on_progress(1.0)
    return video_path, thumb_path
