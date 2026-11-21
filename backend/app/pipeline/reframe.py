from pathlib import Path

import cv2
import numpy as np


ASPECTS = {"9:16": 9 / 16, "1:1": 1.0, "16:9": 16 / 9}


def crop_size(src_w: int, src_h: int, aspect: float = 9 / 16) -> tuple[int, int]:
    if src_w / src_h > aspect:
        return min(src_w, int(round(src_h * aspect / 2)) * 2), src_h
    return src_w, min(src_h, int(round(src_w / aspect / 2)) * 2)


def output_size(aspect: str, crop_w: int, crop_h: int) -> tuple[int, int]:
    if aspect == "9:16":
        return 1080, 1920
    if aspect == "1:1":
        return 1080, 1080
    if aspect == "16:9":
        return 1920, 1080
    scale = min(1.0, 1920 / max(crop_w, crop_h))
    return int(crop_w * scale) // 2 * 2, int(crop_h * scale) // 2 * 2


def plan_crop(source: Path, start: float, end: float, src_w: int, src_h: int, aspect: str, crop_mode: str = "auto", crop_x: float | None = None) -> dict:
    """Returns the crop window size, vertical offset, and the left-edge track over time."""
    ratio = ASPECTS.get(aspect, src_w / src_h)
    crop_w, crop_h = crop_size(src_w, src_h, ratio)
    max_left = max(0, src_w - crop_w)
    fixed = {"center": 0.5, "left": 0.0, "right": 1.0, "manual": 0.5 if crop_x is None else crop_x}
    if crop_mode in fixed or max_left == 0:
        left = max_left * fixed.get(crop_mode, 0.5)
        times, lefts = np.array([0.0]), np.array([left])
    else:
        times, lefts = track_subject(source, start, end, src_w, crop_w)
    return {"crop_w": crop_w, "crop_h": crop_h, "top": (src_h - crop_h) // 2, "times": times, "lefts": lefts}


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
