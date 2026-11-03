# The API image, also run by the collector job (`python -m pipeline.live`). Data is not baked in:
# backend.fetch downloads it from DATA_URL at start, the job pulls its own files from there.
# python:3.14-slim (the minor version the tests run on), multi-arch index digest
FROM python:3.14-slim@sha256:82abc9f53600280b0757126f83c5a7d47088592d2acb6b4c0b9e97f76865508c

# uv 0.10.2, multi-arch index digest
COPY --from=ghcr.io/astral-sh/uv:0.10.2@sha256:94a23af2d50e97b87b522d3cea24aaf8a1faedec1344c952767434f69585cbf9 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-default-groups
COPY core ./core
COPY backend ./backend
COPY pipeline ./pipeline

RUN useradd --system --no-create-home app && mkdir data && chown app data
USER app

# One worker: the query cap and the caches are per process (docs/patterns.md section 8).
CMD ["sh", "-c", "python -m backend.fetch && exec uvicorn backend.main:app --host 0.0.0.0 --port 8000 --no-access-log"]
