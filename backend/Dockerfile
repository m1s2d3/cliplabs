FROM python:3.12-slim

# ffmpeg for media processing; fonts-dejavu for caption rendering (macOS fonts aren't available here, see captions.py FONT_FALLBACKS).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV CLIPLABS_DATA_DIR=/data
# No VOLUME instruction: Railway doesn't support Docker's native VOLUME directive.
# Attach a Railway Volume mounted at /data instead (railway volume add --mount-path /data).

# Railway/Render inject $PORT; default to 8000 for other hosts.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
