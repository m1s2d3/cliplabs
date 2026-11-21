import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DATA_DIR = Path(os.getenv("CLIPLABS_DATA_DIR", str(BASE_DIR / "data"))).resolve()
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "cliplabs.db"

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_MULTILINGUAL_MODEL = os.getenv("WHISPER_MULTILINGUAL_MODEL", "small")

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "2048"))
MAX_SOURCE_SECONDS = int(os.getenv("MAX_SOURCE_SECONDS", str(12 * 60 * 60)))
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:4173,http://127.0.0.1:4173").split(",") if o.strip()]

UPLOAD_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}

OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
OUTPUT_FPS = 30

CAPTION_FONT = os.getenv("CAPTION_FONT", "/System/Library/Fonts/Supplemental/Arial Black.ttf")


def ensure_dirs() -> None:
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
