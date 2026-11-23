from pathlib import Path

import cv2
import numpy as np


ASPECTS = {"9:16": 9 / 16, "1:1": 1.0, "16:9": 16 / 9}


def _aspect_ratio(aspect: str, src_w: int, src_h: int) -> float:
    if aspect.startswith("custom:"):
        width, height = (int(value) for value in aspect.removeprefix("custom:").split("x", 1))
        return width / height
    return ASPECTS.get(aspect, src_w / src_h)


def crop_size(src_w: int, src_h: int, aspect: float = 9 / 16, zoom: float = 1.0) -> tuple[int, int]:
    """zoom < 1 shrinks the crop window (more zoomed-in result); 1.0 is the largest crop that fits the source."""
    if src_w / src_h > aspect:
        w, h = min(src_w, int(round(src_h * aspect / 2)) * 2), src_h
    else:
        w, h = src_w, min(src_h, int(round(src_w / aspect / 2)) * 2)
    zoom = max(0.3, min(1.0, zoom))
    if zoom < 1.0:
        w, h = max(2, int(round(w * zoom / 2)) * 2), max(2, int(round(h * zoom / 2)) * 2)
    return w, h


def output_size(aspect: str, crop_w: int, crop_h: int, resolution: int = 1080) -> tuple[int, int]:
    if aspect.startswith("custom:"):
        width, height = (int(value) for value in aspect.removeprefix("custom:").split("x", 1))
        return width, height
    if aspect == "9:16":
        return resolution, resolution * 16 // 9
    if aspect == "1:1":
        return resolution, resolution
    if aspect == "16:9":
        return resolution * 16 // 9, resolution
    target = min(resolution, max(crop_w, crop_h))
    ratio = crop_w / crop_h
    if ratio >= 1:
        return int(target * ratio) // 2 * 2, target // 2 * 2
    return target // 2 * 2, int(target / ratio) // 2 * 2


def plan_area(src_w: int, src_h: int, out_w: int, out_h: int, area: tuple[float, float, float, float]) -> dict:
    x, y, width, height = area
    left, top = int(round(x * src_w)), int(round(y * src_h))
    box_w = max(2, min(src_w - left, int(round(width * src_w))))
    box_h = max(2, min(src_h - top, int(round(height * src_h))))
    target_ratio = out_w / out_h
    if box_w / box_h > target_ratio:
        crop_h = box_h
        crop_w = max(2, int(round(crop_h * target_ratio / 2)) * 2)
    else:
        crop_w = box_w
        crop_h = max(2, int(round(crop_w / target_ratio / 2)) * 2)
    crop_w, crop_h = min(crop_w, box_w), min(crop_h, box_h)
    return {"crop_w": crop_w, "crop_h": crop_h, "top": top + (box_h - crop_h) // 2, "left": left + (box_w - crop_w) // 2}


def plan_crop(source: Path, start: float, end: float, src_w: int, src_h: int, aspect: str, crop_mode: str = "auto", crop_x: float | None = None, zoom: float = 1.0, area: tuple[float, float, float, float] | None = None, crop_y: float | None = None) -> dict:
    """Returns the crop window size, vertical offset, and the left-edge track over time."""
    ratio = _aspect_ratio(aspect, src_w, src_h)
    if area is not None:
        selected = plan_area(src_w, src_h, int(round(ratio * 1000)), 1000, area)
        return {**selected, "times": np.array([0.0]), "lefts": np.array([selected["left"]])}
    crop_w, crop_h = crop_size(src_w, src_h, ratio, zoom)
    max_left = max(0, src_w - crop_w)
    fixed = {"center": 0.5, "left": 0.0, "right": 1.0, "manual": 0.5 if crop_x is None else crop_x}
    if crop_mode in fixed or max_left == 0:
        left = max_left * fixed.get(crop_mode, 0.5)
        times, lefts = np.array([0.0]), np.array([left])
    else:
        times, lefts = track_subject(source, start, end, src_w, crop_w)
    top = round(max(0, src_h - crop_h) * (0.5 if crop_y is None else crop_y))
    return {"crop_w": crop_w, "crop_h": crop_h, "top": top, "times": times, "lefts": lefts}


def plan_band(source: Path, start: float, end: float, src_w: int, src_h: int, out_w: int, band_h: int, crop_x: float | None = None, zoom: float = 1.0, area: tuple[float, float, float, float] | None = None, crop_y: float | None = None) -> dict:
    """A face-tracked (or fixed, if crop_x is given) crop window sized to an out_w x band_h band."""
    if area is not None:
        return plan_area(src_w, src_h, out_w, band_h, area)
    w, h = crop_size(src_w, src_h, out_w / band_h, zoom)
    max_left = max(0, src_w - w)
    if crop_x is None:
        times, lefts = track_subject(source, start, end, src_w, w)
    else:
        times, lefts = np.array([0.0]), np.array([max_left * crop_x])
    top = round(max(0, src_h - h) * (0.5 if crop_y is None else crop_y))
    return {"crop_w": w, "crop_h": h, "top": top, "times": times, "lefts": lefts}


def static_band(src_w: int, src_h: int, out_w: int, band_h: int, crop_x: float = 0.5, zoom: float = 1.0, area: tuple[float, float, float, float] | None = None, crop_y: float | None = None) -> dict:
    """A fixed, non-tracked crop window sized to an out_w x band_h band."""
    if area is not None:
        return plan_area(src_w, src_h, out_w, band_h, area)
    w, h = crop_size(src_w, src_h, out_w / band_h, zoom)
    left = int(round(max(0, src_w - w) * crop_x))
    top = round(max(0, src_h - h) * (0.5 if crop_y is None else crop_y))
    return {"crop_w": w, "crop_h": h, "top": top, "left": left}


def plan_split(source: Path, start: float, end: float, src_w: int, src_h: int, out_w: int, half_h: int, crop_x: float | None = None, crop_x2: float | None = None, flip: bool = False, zoom: float = 1.0, zoom2: float = 1.0, camera_area: tuple[float, float, float, float] | None = None, gameplay_area: tuple[float, float, float, float] | None = None, crop_y: float | None = None, crop_y2: float | None = None) -> dict:
    """Builds the two stacked half-plans; the face-tracked half is the bottom one when flip=True."""
    face = plan_band(source, start, end, src_w, src_h, out_w, half_h, crop_x, zoom, camera_area, crop_y)
    other = static_band(src_w, src_h, out_w, half_h, 0.5 if crop_x2 is None else crop_x2, zoom2, gameplay_area, crop_y2)
    return {"top": other, "bottom": face} if flip else {"top": face, "bottom": other}


def plan_split3(source: Path, start: float, end: float, src_w: int, src_h: int, out_w: int, band_h: int, crop_x: float | None = None, crop_x2: float | None = None, zoom: float = 1.0, zoom2: float = 1.0, camera_area: tuple[float, float, float, float] | None = None, gameplay_area: tuple[float, float, float, float] | None = None, crop_y: float | None = None, crop_y2: float | None = None) -> dict:
    """Three stacked bands: a face-tracked top, a static centered middle, and a static (or manual) bottom."""
    top = plan_band(source, start, end, src_w, src_h, out_w, band_h, crop_x, zoom, camera_area, crop_y)
    middle = static_band(src_w, src_h, out_w, band_h, 0.5)
    bottom = static_band(src_w, src_h, out_w, band_h, 0.5 if crop_x2 is None else crop_x2, zoom2, gameplay_area, crop_y2)
    return {"top": top, "middle": middle, "bottom": bottom}


def plan_pip(source: Path, start: float, end: float, src_w: int, src_h: int, aspect: str, out_w: int, out_h: int, crop_mode: str, crop_x: float | None, zoom: float = 1.0, camera_area: tuple[float, float, float, float] | None = None, gameplay_area: tuple[float, float, float, float] | None = None, crop_x2: float | None = None, crop_y: float | None = None, crop_y2: float | None = None, zoom2: float = 1.0) -> dict:
    """A fullscreen background crop plus a small face-tracked square bubble for the corner overlay."""
    background_mode = "manual" if crop_mode == "pip" and crop_x is not None else "auto" if crop_mode == "pip" else crop_mode
    background = plan_crop(source, start, end, src_w, src_h, aspect, background_mode, crop_x, zoom, gameplay_area, crop_y)
    bubble_size = int(round(out_w * 0.34))
    bubble = plan_band(source, start, end, src_w, src_h, bubble_size, bubble_size, crop_x2, zoom2, area=camera_area, crop_y=crop_y2)
    return {"background": background, "bubble": bubble, "bubble_size": bubble_size}


def plan_side_by_side(source: Path, start: float, end: float, src_w: int, src_h: int, out_w: int, out_h: int, crop_x: float | None = None, crop_x2: float | None = None, zoom: float = 1.0, zoom2: float = 1.0, camera_area: tuple[float, float, float, float] | None = None, gameplay_area: tuple[float, float, float, float] | None = None, crop_y: float | None = None, crop_y2: float | None = None) -> dict:
    """Build side-by-side camera and gameplay crops, each filling one output column."""
    half_w = out_w // 2
    camera = plan_band(source, start, end, src_w, src_h, half_w, out_h, crop_x, zoom, camera_area, crop_y)
    gameplay = static_band(src_w, src_h, half_w, out_h, 0.5 if crop_x2 is None else crop_x2, zoom2, gameplay_area, crop_y2)
    return {"left": camera, "right": gameplay}


def track_subject(source: Path, start: float, end: float, src_w: int, crop_w: int, sample_fps: float = 4.0) -> tuple[np.ndarray, np.ndarray]:
    """Returns sample times (relative to clip start) and the crop's left edge for each sample."""
    max_left = max(0, src_w - crop_w)
    if max_left == 0:
        return np.array([0.0]), np.array([0.0])

    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    cap = cv2.VideoCapture(str(source))
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(fps / sample_fps)))

    times, centers, previous, frame_index = [], [], None, 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        position = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        if position > end:
            break
        if frame_index % step == 0:
            ok, frame = cap.retrieve()
            if ok:
                center = _detect_center(cascade, frame, previous)
                previous = center if center is not None else previous
                times.append(max(0.0, position - start))
                centers.append(center)
        frame_index += 1
    cap.release()

    if not times:
        return np.array([0.0]), np.array([max_left / 2])
    lefts = _smooth(centers, src_w, crop_w) - crop_w / 2
    return np.array(times), np.clip(lefts, 0, max_left)


def _detect_center(cascade: cv2.CascadeClassifier, frame: np.ndarray, previous: float | None) -> float | None:
    height, width = frame.shape[:2]
    scale = 480 / width if width > 480 else 1.0
    small = cv2.resize(frame, (int(width * scale), int(height * scale))) if scale < 1 else frame
    gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(28, 28))
    if len(faces) == 0:
        return None

    def weight(face) -> float:
        x, _, w, h = face
        center = (x + w / 2) / scale
        stickiness = 1.0 if previous is None else 1 + max(0.0, 1 - abs(center - previous) / (width / 3))
        return w * h * stickiness

    x, _, w, _ = max(faces, key=weight)
    return float((x + w / 2) / scale)


def _smooth(centers: list[float | None], src_w: int, crop_w: int) -> np.ndarray:
    known = [c for c in centers if c is not None]
    if not known:
        return np.full(len(centers), src_w / 2)
    filled, last = [], known[0]
    for center in centers:
        last = center if center is not None else last
        filled.append(last)
    values = np.array(filled, dtype=np.float64)

    if len(values) >= 5:
        padded = np.pad(values, 2, mode="edge")
        values = np.array([np.median(padded[i:i + 5]) for i in range(len(values))])

    # Hold the camera still until the subject leaves a dead zone, then ease toward it.
    dead_zone = crop_w * 0.12
    camera = np.empty_like(values)
    position = values[0]
    for i, target in enumerate(values):
        offset = target - position
        if abs(offset) > dead_zone:
            position += (offset - np.sign(offset) * dead_zone) * 0.35
        camera[i] = position
    return camera
