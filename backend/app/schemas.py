from typing import Literal

from pydantic import BaseModel, Field, model_validator

Language = Literal["auto", "en", "hi", "pa", "ur", "bn", "ta", "te", "mr", "gu", "es", "fr", "de", "pt", "ar"]
Aspect = Literal["9:16", "1:1", "16:9"]
CutAspect = Literal["original", "9:16", "1:1", "16:9"]
CaptionStyle = Literal["classic", "highlight", "karaoke", "minimal", "bold"]
CropMode = Literal["auto", "center", "left", "right", "manual"]


class ClipOptions(BaseModel):
    clip_count: int = Field(5, ge=1, le=10)
    min_length: float = Field(20, ge=5, le=170)
    max_length: float = Field(60, ge=10, le=180)
    captions: bool = True
    caption_style: CaptionStyle = "classic"
    language: Language = "auto"
    content_type: Literal["talking", "music", "gaming"] = "talking"
    aspect: Aspect = "9:16"
    range_start: float | None = Field(None, ge=0)
    range_end: float | None = Field(None, gt=0)

    @model_validator(mode="after")
    def check(self) -> "ClipOptions":
        if self.max_length < self.min_length + 5:
            raise ValueError("max_length must be at least 5 seconds longer than min_length")
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

    @model_validator(mode="after")
    def check(self) -> "CutOptions":
        if not 1 <= self.end - self.start <= 600:
            raise ValueError("A cut must be between 1 second and 10 minutes long")
        return self


class DownloadOptions(BaseModel):
    kind: Literal["video", "audio"] = "video"
    quality: Literal["best", "2160", "1440", "1080", "720", "480", "360"] = "1080"
    audio_format: Literal["m4a", "mp3"] = "m4a"


MODE_OPTIONS = {"clips": ClipOptions, "cut": CutOptions, "download": DownloadOptions}


class CreateProject(BaseModel):
    url: str = Field(max_length=2048)
    mode: Literal["clips", "cut", "download"] = "clips"
    options: dict = Field(default_factory=dict)


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
    crop_mode: CropMode | None = None
    crop_x: float | None = Field(None, ge=0, le=1)
    aspect: CutAspect | None = None
