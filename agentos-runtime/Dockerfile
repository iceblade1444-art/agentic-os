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

# The probe carries the runtime token, because the runtime stopped answering
# anonymous callers in Stage 0 (d29dc93) and this check did not. It has read
# 401 -> unhealthy ever since: a container reporting sick while serving every
# real request correctly, which is worse than no check at all — it is a smoke
# alarm that has been going off for days, so nobody looks when it means it.
#
# The header is omitted when no token is set, which is how a local run without
# one still passes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; t = os.environ.get('AGENTOS_RUNTIME_TOKEN', ''); urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765/api/mila/status', headers={'Authorization': 'Bearer ' + t} if t else {}), timeout=3).read()"

CMD ["python", "dashboard/backend/app.py", "--workspace", "/app", "--host", "0.0.0.0", "--port", "8765"]
