FROM python:3.12-slim@sha256:2c941e860699f878900b0edc2403613c234d4b32eda3cc9fa7036991a2a63c4a

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt \
    && pip check

COPY . .

# The backend is a long-running local API and does not require root. Keep the
# application tree root-owned/read-only, but prepare the only persistent write
# location for the same numeric UID/GID used by the torrent engine and runtime.
RUN mkdir -p /var/lib/netwatch/cache \
    && chown 1000:1000 /var/lib/netwatch/cache

EXPOSE 8000

USER 1000:1000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
