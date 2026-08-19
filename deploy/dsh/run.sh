#!/usr/bin/env bash
# Build and (re)start the DeepSeek Harness container next to Agentic OS.
# Run on the server: bash deploy/dsh/run.sh
set -e
cd "$(dirname "$0")"

docker build -t agentic-dsh .
docker rm -f dsh 2>/dev/null || true
docker run -d --name dsh --restart unless-stopped \
  --network agentic-os_default \
  --memory 2g \
  -v dsh-home:/data/home \
  -v dsh-workspace:/data/workspace \
  agentic-dsh
echo "· dsh is up: reachable as http://dsh:3081 on the agentic-os_default network"
