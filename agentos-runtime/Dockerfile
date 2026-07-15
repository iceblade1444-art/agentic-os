FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/admilana \
    PATH=/home/admilana/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY . /app

RUN mkdir -p /home/admilana /app/logs/runtime \
    && chown -R 1000:1000 /home/admilana /app

USER 1000:1000

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/mila/status', timeout=3).read()"

CMD ["python", "dashboard/backend/app.py", "--workspace", "/app", "--host", "0.0.0.0", "--port", "8765"]
