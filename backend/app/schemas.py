from typing import Literal

from pydantic import BaseModel, Field, model_validator

Language = Literal["auto", "en", "hi", "pa", "ur", "bn", "ta", "te", "mr", "gu", "es", "fr", "de", "pt", "ar"]
Aspect = Literal["9:16", "1:1", "16:9", "custom"]
CutAspect = Literal["original", "9:16", "1:1", "16:9", "custom"]
CaptionStyle = Literal["classic", "highlight", "karaoke", "minimal", "bold"]
CropMode = Literal["auto", "center", "left", "right", "manual", "split", "split_flip", "split3", "pip", "blur_fill", "side_by_side"]
PipPosition = Literal["top_left", "top_right", "bottom_left", "bottom_right"]
PipShape = Literal["circle", "square", "freeform"]


class ClipOptions(BaseModel):
    clip_count: int = Field(5, ge=1, le=10)
    min_length: float = Field(20, ge=5, le=170)
    max_length: float = Field(60, ge=10, le=180)
    captions: bool = False
    caption_style: CaptionStyle = "classic"
    language: Language = "auto"
    content_type: Literal["talking", "music", "gaming"] = "talking"
    crop_mode: CropMode = "auto"
    pip_position: PipPosition = "bottom_right"
    pip_shape: PipShape = "circle"
    find_facecam: bool = True
    facecam_area: tuple[float, float, float, float] | None = None
    gameplay_area: tuple[float, float, float, float] | None = None
    aspect: Aspect = "9:16"
    output_resolution: int = Field(1080, ge=144, le=4320)
    output_width: int | None = Field(None, ge=144, le=4320, multiple_of=2)
    output_height: int | None = Field(None, ge=144, le=4320, multiple_of=2)
    frame_rate: Literal[24, 30, 60] = 30
    range_start: float | None = Field(None, ge=0)
    range_end: float | None = Field(None, gt=0)

    @model_validator(mode="after")
    def check(self) -> "ClipOptions":
        if self.max_length < self.min_length + 5:
            raise ValueError("max_length must be at least 5 seconds longer than min_length")
        if self.aspect == "custom" and (self.output_width is None or self.output_height is None):
            raise ValueError("Custom output requires a width and height")
        for area in (self.facecam_area, self.gameplay_area):
            if area is not None and (any(value < 0 or value > 1 for value in area) or area[2] <= 0 or area[3] <= 0 or area[0] + area[2] > 1 or area[1] + area[3] > 1):
                raise ValueError("Selected areas must fit inside the source frame")
        if self.range_start is not None and self.range_end is not None and self.range_end - self.range_start < self.min_length:
            raise ValueError("The analysis range is shorter than the minimum clip length")
        return self


class CutOptions(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    aspect: CutAspect = "original"
    captions: bool = False
    caption_style: CaptionStyle = "classic"
    language: Language = "auto"
    output_resolution: int = Field(1080, ge=144, le=4320)
    output_width: int | None = Field(None, ge=144, le=4320, multiple_of=2)
    output_height: int | None = Field(None, ge=144, le=4320, multiple_of=2)
    frame_rate: Literal[24, 30, 60] = 30

    @model_validator(mode="after")
    def check(self) -> "CutOptions":
        if not 1 <= self.end - self.start <= 600:
            raise ValueError("A cut must be between 1 second and 10 minutes long")
        if self.aspect == "custom" and (self.output_width is None or self.output_height is None):
            raise ValueError("Custom output requires a width and height")
        return self


class DownloadOptions(BaseModel):
    kind: Literal["video", "audio"] = "video"
    quality: Literal["best", "2160", "1440", "1080", "720", "480", "360"] = "1080"
    audio_format: Literal["m4a", "mp3"] = "m4a"
    range_start: float | None = Field(None, ge=0)
    range_end: float | None = Field(None, gt=0)

    @model_validator(mode="after")
    def check_range(self) -> "DownloadOptions":
        if self.range_start is not None and self.range_end is not None and self.range_end <= self.range_start:
            raise ValueError("Download end time must be after start time")
        return self


MODE_OPTIONS = {"clips": ClipOptions, "cut": CutOptions, "download": DownloadOptions}


class CreateProject(BaseModel):
    url: str = Field(max_length=2048)
    mode: Literal["clips", "cut", "download"] = "clips"
    options: dict = Field(default_factory=dict)


class RetryOptions(BaseModel):
    content_type: Literal["talking", "music", "gaming"] | None = None


class CaptionLine(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(max_length=200)


class ClipUpdate(BaseModel):
    title: str | None = Field(None, max_length=120)
    start: float | None = Field(None, ge=0)
    end: float | None = Field(None, gt=0)
    captions_enabled: bool | None = None
    captions: list[CaptionLine] | None = Field(None, max_length=500)
    caption_style: CaptionStyle | None = None
    caption_position: float | None = Field(None, ge=0, le=1)
    crop_mode: CropMode | None = None
    aspect: CutAspect | None = None
    crop_x: float | None = Field(None, ge=0, le=1)
    crop_x2: float | None = Field(None, ge=0, le=1)
    crop_y: float | None = Field(None, ge=0, le=1)
    crop_y2: float | None = Field(None, ge=0, le=1)
    crop_zoom: float | None = Field(None, ge=0.3, le=1)
    crop_zoom2: float | None = Field(None, ge=0.3, le=1)
    crop_area: tuple[float, float, float, float] | None = None
    crop_area2: tuple[float, float, float, float] | None = None
    pip_position: PipPosition | None = None
    pip_shape: PipShape | None = None
    hook: str | None = Field(None, max_length=140)
    hook_enabled: bool | None = None
    hook_duration: float | None = Field(None, ge=1, le=10)
    export_resolution: str | None = Field(None, pattern=r"^\d{3,4}x\d{3,4}$")
    frame_rate: float | None = Field(None, ge=24, le=60)

    @model_validator(mode="after")
    def check_areas(self) -> "ClipUpdate":
        for area in (self.crop_area, self.crop_area2):
            if area is not None and (any(v < 0 or v > 1 for v in area) or area[2] <= 0 or area[3] <= 0 or area[0] + area[2] > 1 or area[1] + area[3] > 1):
                raise ValueError("Selected areas must fit inside the source frame")
        return self
