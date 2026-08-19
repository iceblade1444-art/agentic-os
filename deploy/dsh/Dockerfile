# DeepSeek Harness (dsh) for Agentic OS.
#
# dsh deliberately refuses --host 0.0.0.0: its web server binds 127.0.0.1
# inside the container, where nobody else can reach it. The socat relay in CMD
# republishes that loopback port on 0.0.0.0:3081 for the docker network, so
# the only way in is agentic-os's authenticated /dsh proxy — the UI itself is
# never exposed on the host.
#
# The agent runs real bash in its workspace; this container IS the sandbox.
# Its filesystem is two named volumes (home + workspace) and nothing of the
# host. Build: docker build -t agentic-dsh deploy/dsh
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends socat git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pinned: dsh is a developer preview and warns about breaking changes.
RUN npm install -g @deepseek-ai/dsh@0.1.0-rc.7

ENV DSH_HOME=/data/home
WORKDIR /data/workspace

EXPOSE 3081
CMD ["sh", "-c", "socat TCP-LISTEN:3081,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:3080 & exec dsh web"]
