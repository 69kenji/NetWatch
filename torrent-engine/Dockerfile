FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/netwatch-venv/bin:$PATH

# Ubuntu 24.04 ships the native Python bindings for libtorrent-rasterbar 2.0.x.
# Use the distro package rather than an unofficial wheel, then expose it inside a
# small venv via --system-site-packages for the FastAPI dependencies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-libtorrent \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv --system-site-packages /opt/netwatch-venv

WORKDIR /app
COPY requirements.txt requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt \
    && pip check

COPY . .

USER 1000:1000

EXPOSE 8081
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8081", "--workers", "1"]
