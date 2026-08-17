FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py .

# long polling only — nothing listens, so no port and no healthcheck endpoint
CMD ["python", "-u", "bot.py"]
