import subprocess
import tempfile
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image

from .. import config
from .captions import CaptionRenderer, blend
from .media import PipelineError
from .reframe import output_size, plan_crop


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
) -> tuple[Path, Path]:
    """Decodes the source span, applies the crop and captions per frame, and encodes an MP4."""
    out_dir.mkdir(parents=True, exist_ok=True)
    duration = end - start
    fps = config.OUTPUT_FPS
    plan = plan_crop(source, start, end, src_w, src_h, aspect, crop_mode, crop_x)
    crop_w, crop_h, top, times, lefts = plan["crop_w"], plan["crop_h"], plan["top"], plan["times"], plan["lefts"]
    out_w, out_h = output_size(aspect, crop_w, crop_h)
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
                left = int(round(np.interp(t, times, lefts)))
                cropped = frame[top:top + crop_h, left:left + crop_w]
                out = cv2.resize(cropped, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
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
