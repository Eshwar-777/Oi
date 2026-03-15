FROM python:3.11-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.11-slim

WORKDIR /app

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=src \
    PORT=8080 \
    GUNICORN_WORKERS=1

COPY --from=builder /opt/venv /opt/venv
COPY src/ src/
COPY prompts/ prompts/
COPY skills/ skills/
COPY configs/ configs/

RUN /opt/venv/bin/python -m playwright install --with-deps chromium

RUN adduser --disabled-password --gecos "" appuser \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 8080

CMD ["sh", "-c", "exec gunicorn oi_agent.main:app -k uvicorn.workers.UvicornWorker -w ${GUNICORN_WORKERS:-1} -b 0.0.0.0:${PORT:-8080} --timeout 120"]
