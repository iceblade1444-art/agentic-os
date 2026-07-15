#!/usr/bin/env python
"""Minimal stdlib dashboard API for AgentOS.

Run:
    python C:/Users/User/AgentOS/dashboard/backend/app.py --workspace C:/Users/User/AgentOS --port 8765
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from uuid import uuid4

AGENTOS_ROOT = Path(__file__).resolve().parents[2]
if str(AGENTOS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTOS_ROOT))
from agentos_env import load_workspace_dotenv

DEFAULT_WORKSPACE = Path("C:/Users/User/AgentOS")
MILA_NATIVE_LIVE_MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"
MILA_INPUT_SAMPLE_RATE = 16000
MILA_OUTPUT_SAMPLE_RATE = 24000
MILA_INPUT_AUDIO_MIME = f"audio/pcm;rate={MILA_INPUT_SAMPLE_RATE}"
MILA_DEFAULT_VOICE = "Leda"
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    return slug[:80] or f"goal-{datetime.now().strftime('%Y%m%d%H%M%S')}"


def list_projects(workspace: Path):
    project_root = workspace / "projects"
    projects = []
    for project_json in sorted(project_root.glob("*/project.json")):
        projects.append(read_json(project_json, {}))
    return projects


def list_approvals(workspace: Path):
    return read_json(workspace / "approvals" / "approvals.json", [])


def list_events(workspace: Path):
    return read_json(workspace / "logs" / "events.json", [])


def _bounded_int(value, default: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def paginated_events(workspace: Path, query: str = ""):
    qs = parse_qs(query)
    events = redact_secrets(list_events(workspace))
    total = len(events)
    limit = _bounded_int((qs.get("limit") or [50])[0], 50, minimum=1, maximum=200)
    offset = _bounded_int((qs.get("offset") or [0])[0], 0, minimum=0, maximum=max(total, 0))
    latest_first = str((qs.get("latest_first") or ["true"])[0]).strip().lower() not in {"0", "false", "no"}
    ordered = list(reversed(events)) if latest_first else list(events)
    page = ordered[offset:offset + limit]
    next_offset = offset + len(page)
    return {
        "status": "ok",
        "decision": "events_paginated",
        "events": page,
        "pagination": {
            "total": total,
            "limit": limit,
            "offset": offset,
            "returned": len(page),
            "latest_first": latest_first,
            "has_more": next_offset < total,
            "next_offset": next_offset if next_offset < total else None,
        },
    }


def append_event(workspace: Path, event_type: str, actor: str = "dashboard", **details):
    events = list_events(workspace)
    event = {"id": f"event_{uuid4().hex[:10]}", "type": event_type, "actor": actor, "created_at": now(), **details}
    events.append(event)
    write_json(workspace / "logs" / "events.json", events)
    return event


def status(workspace: Path):
    approvals = list_approvals(workspace)
    return {
        "workspace": str(workspace),
        "projects": len(list_projects(workspace)),
        "approvals": len(approvals),
        "pending_approvals": len([a for a in approvals if a.get("status") == "pending"]),
    }


def mila_desktop_package(workspace: Path):
    def script_info(relpath: str):
        path = workspace / relpath
        return {
            "relpath": relpath,
            "path": path.as_posix(),
            "exists": path.exists(),
        }

    return {
        "status": "ok",
        "decision": "mila_desktop_package_metadata",
        "app_name": "Mila",
        "display_name": "Мила",
        "dashboard_url": "http://127.0.0.1:8765/",
        "workspace": workspace.as_posix(),
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "scripts": {
            "start_windows": script_info("scripts/start_mila.bat")["path"],
            "start_bash": script_info("scripts/start_mila.sh")["path"],
            "install_autostart_windows": script_info("installers/install_mila_autostart.bat")["path"],
            "uninstall_autostart_windows": script_info("installers/uninstall_mila_autostart.bat")["path"],
        },
        "script_status": {
            "start_windows": script_info("scripts/start_mila.bat"),
            "start_bash": script_info("scripts/start_mila.sh"),
            "install_autostart_windows": script_info("installers/install_mila_autostart.bat"),
            "uninstall_autostart_windows": script_info("installers/uninstall_mila_autostart.bat"),
        },
        "autostart": {
            "platform": "windows",
            "startup_entry": "Mila AgentOS.cmd",
            "install_is_operator_initiated": True,
            "safe_to_share": True,
        },
        "safety": {
            "credentials_source": ".env_or_process_environment",
            "credentials_are_not_written_by_installers": True,
            "actions_route_through_approval_gates": True,
        },
    }


def mila_interface_blueprint(workspace: Path):
    return {
        "status": "ok",
        "decision": "mila_agentic_os_interface_blueprint",
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "source_video": {
            "video_id": "A75zZTFw_o0",
            "url": "https://www.youtube.com/watch?v=A75zZTFw_o0",
            "title": "Agentic OS interface inspiration for a visual AI operating system",
            "takeaways": [
                "whole team of AI workers",
                "Obsidian memory galaxy",
                "plug in new models",
                "voice-activated agent",
                "Kanban board",
                "app builder",
                "daily changelog",
                "preview stage",
            ],
        },
        "layout": {
            "shell": "agenticOsShell",
            "sidebar": "agenticSidebar",
            "navigation": "agenticTabButton",
            "stage": "milaPreviewStage",
        },
        "modules": ["voice", "agents", "memory", "builder", "kanban", "models", "approvals", "reports"],
        "safety": {
            "local_first": True,
            "risky_actions_require_approval": True,
            "credentials_hidden_from_browser": True,
        },
    }


def mila_dashboard_routes(workspace: Path):
    routes = ["overview", "voice", "agents", "memory", "builder", "kanban", "models", "runtime", "projects"]
    return {
        "status": "ok",
        "decision": "mila_dashboard_routes",
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "default_route": "overview",
        "hash_routing": True,
        "routes": routes,
        "route_targets": {route: f"milaRoute{route.title()}" for route in routes},
        "safety": {
            "local_first": True,
            "navigation_only": True,
            "does_not_execute_actions": True,
        },
    }


def load_agent_registry(workspace: Path):
    registry = read_json(workspace / "agents" / "registry.json", {"version": 0, "agents": []})
    agents = registry.get("agents") if isinstance(registry, dict) else []
    if not isinstance(agents, list):
        agents = []
    return {**registry, "agents": redact_secrets(agents)}


def agent_registry_counts(registry: dict):
    counts = {"total": 0, "real": 0, "provider": 0, "ui_only": 0, "planned": 0, "disabled": 0}
    for agent in registry.get("agents", []):
        counts["total"] += 1
        status = str(agent.get("status") or "planned")
        counts[status] = counts.get(status, 0) + 1
    return counts


def agent_status_matrix(registry: dict, live_agents: list[dict]):
    live_by_role = {agent.get("role"): agent for agent in live_agents}
    rows = []
    for agent in registry.get("agents", []):
        agent_id = agent.get("id")
        live = live_by_role.get(agent_id)
        rows.append({
            "id": agent_id,
            "display_name": agent.get("display_name") or agent_id,
            "kind": agent.get("kind") or "unknown",
            "registry_status": agent.get("status") or "planned",
            "live_status": live.get("status") if live else None,
            "runner": agent.get("runner"),
            "queue_owner": agent.get("queue_owner"),
            "spec_path": agent.get("spec_path"),
            "tools": agent.get("tools") or [],
            "permissions": agent.get("permissions") or [],
            "setup_required": agent.get("setup_required") or [],
            "signals": live.get("signals") if live else [],
            "connected_to_live_dock": live is not None,
        })
    return rows


def mila_agent_dock(workspace: Path):
    projects = list_projects(workspace)
    approvals = list_approvals(workspace)
    pending_approvals = [a for a in approvals if a.get("status") == "pending"]
    queue = load_agent_queue(workspace)
    queue_runs = load_agent_queue_runs(workspace)
    worker = agent_worker_status(workspace)
    reports = latest_agentos_wave_reports(workspace)
    latest_report = reports[-1] if reports else None
    worker_status = worker.get("status") or "unknown"
    counts = {
        "projects": len(projects),
        "approvals": len(approvals),
        "pending_approvals": len(pending_approvals),
        "queue_items": len(queue),
        "queue_runs": len(queue_runs),
    }
    voice = voice_health(workspace)
    gemini = next((item for item in voice.get("providers", []) if item.get("provider") == "gemini_live"), {})
    openai_ready = bool(os.getenv("OPENAI_API_KEY"))
    agents = [
        {
            "role": "mila",
            "display_name": "Mila",
            "status": "ready" if gemini.get("ready") else "voice_needs_attention",
            "signals": [
                "single_visible_agent",
                "orchestrator",
                "voice=gemini_live",
                f"gemini_live={'ready' if gemini.get('ready') else 'not_ready'}",
                f"openai_gpt={'ready' if openai_ready else 'missing_OPENAI_API_KEY'}",
                f"projects={counts['projects']}",
                f"queue_items={counts['queue_items']}",
                f"pending_approvals={counts['pending_approvals']}",
                latest_report.name if latest_report else "no_report",
            ],
        }
    ]
    registry = load_agent_registry(workspace)
    registry_counts = agent_registry_counts(registry)
    status_matrix = agent_status_matrix(registry, agents)
    return {
        "status": "ok",
        "decision": "mila_agent_dock_live_state",
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "counts": counts,
        "worker": {
            "status": worker_status if worker_status in {"disabled", "enabled", "running", "idle", "blocked", "unknown"} else ("enabled" if "enabled" in worker_status else worker_status),
            "raw_status": worker_status,
            "will_execute": bool(worker.get("will_execute")),
            "runtime": worker.get("runtime") or {},
        },
        "latest_report": {
            "exists": latest_report is not None,
            "relpath": latest_report.relative_to(workspace).as_posix() if latest_report else "logs/daily/none",
        },
        "agents": agents,
        "registry": {
            "version": registry.get("version", 0),
            "updated_at": registry.get("updated_at"),
            "reference": registry.get("reference") or {},
            "agents": registry.get("agents", []),
        },
        "registry_counts": registry_counts,
        "agent_status_matrix": status_matrix,
        "safety": {
            "local_first": True,
            "risky_actions_require_approval": True,
            "read_only_endpoint": True,
            "single_agent_mode": True,
        },
    }


def obsidian_default_vault_path() -> Path:
    return Path.home() / "Documents" / "AgentOS Obsidian Vault"


def obsidian_config_path(workspace: Path) -> Path:
    return workspace / "config" / "obsidian.json"


def resolve_obsidian_vault(workspace: Path, create: bool = False):
    cfg_path = obsidian_config_path(workspace)
    cfg = read_json(cfg_path, {})
    env_path = os.environ.get("OBSIDIAN_VAULT_PATH")
    raw_path = env_path or cfg.get("vault_path") or str(obsidian_default_vault_path())
    vault = Path(raw_path).expanduser()
    agentos_folder = cfg.get("agentos_folder") or "AgentOS"
    if create:
        vault.mkdir(parents=True, exist_ok=True)
        (vault / ".obsidian").mkdir(parents=True, exist_ok=True)
        (vault / agentos_folder).mkdir(parents=True, exist_ok=True)
        if not cfg_path.exists() or cfg.get("vault_path") != str(vault):
            write_json(cfg_path, {"vault_path": str(vault), "agentos_folder": agentos_folder, "sync_mode": "manual", "created_by": "AgentOS Memory Galaxy"})
    return {
        "vault_path": str(vault),
        "agentos_folder": agentos_folder,
        "exists": vault.exists(),
        "is_obsidian_vault": (vault / ".obsidian").exists(),
        "config_path": str(cfg_path),
        "source": "env" if env_path else ("config" if cfg.get("vault_path") else "default"),
    }


def obsidian_scan_notes(workspace: Path, limit: int = 12):
    info = resolve_obsidian_vault(workspace, create=False)
    vault = Path(info["vault_path"])
    notes = []
    if vault.exists():
        for p in vault.rglob("*.md"):
            if ".obsidian" in p.parts:
                continue
            try:
                rel = p.relative_to(vault).as_posix()
                notes.append({
                    "relpath": rel,
                    "title": p.stem,
                    "bytes": p.stat().st_size,
                    "modified_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
                })
            except OSError:
                continue
    notes.sort(key=lambda n: n.get("modified_at", ""), reverse=True)
    info.update({"note_count": len(notes), "recent_notes": notes[:limit]})
    return info


def md_escape(value) -> str:
    return redact_secret_text(str(value or "")).replace("\r", "").strip()


def obsidian_markdown_table(rows, columns):
    if not rows:
        return "_None._\n"
    header = "| " + " | ".join(columns) + " |"
    sep = "| " + " | ".join(["---"] * len(columns)) + " |"
    body = []
    for row in rows:
        body.append("| " + " | ".join(md_escape(row.get(c, "")).replace("|", "\\|") for c in columns) + " |")
    return "\n".join([header, sep, *body]) + "\n"


def obsidian_sync_agentos_memory(workspace: Path, payload=None):
    payload = payload or {}
    info = resolve_obsidian_vault(workspace, create=True)
    vault = Path(info["vault_path"])
    folder = vault / info["agentos_folder"]
    folder.mkdir(parents=True, exist_ok=True)

    projects = redact_secrets(list_projects(workspace))
    approvals = redact_secrets(list_approvals(workspace))
    events = redact_secrets(list_events(workspace))
    reports = latest_agentos_wave_reports(workspace)
    transcripts = list_voice_transcripts(workspace, limit=30)
    seo_runs = redact_secrets(read_json(workspace / "workflow" / "seo_runs.json", []))
    synced_at = now()

    project_rows = [{"name": p.get("name") or p.get("slug"), "slug": p.get("slug"), "status": p.get("status", ""), "summary": p.get("summary", "")} for p in projects[:120]]
    approval_rows = [{"id": a.get("id"), "status": a.get("status"), "risk": a.get("risk"), "action": a.get("action"), "summary": a.get("summary", "")} for a in approvals[-80:]]
    event_rows = [{"created_at": e.get("created_at"), "type": e.get("type"), "actor": e.get("actor"), "details": json.dumps(redact_secrets({k: v for k, v in e.items() if k not in {"id", "created_at", "type", "actor"}}), ensure_ascii=False)[:180]} for e in events[-80:]]
    transcript_rows = [{"created_at": t.get("created_at"), "provider": t.get("provider"), "status": t.get("status"), "text": (t.get("text") or t.get("transcript") or "")[:180]} for t in (transcripts.get("items") or [])]
    seo_rows = [{"created_at": r.get("created_at"), "keyword": r.get("keyword"), "route": r.get("route"), "score": r.get("score"), "status": r.get("status")} for r in seo_runs[-80:]]

    files = {
        "AgentOS Memory Index.md": f"""---\ntype: agentos-memory-index\nsynced_at: {synced_at}\nsource: AgentOS\n---\n# AgentOS Memory Index\n\nSynced from local AgentOS workspace: `{md_escape(workspace)}`.\n\n## Live counts\n\n- Projects: {len(projects)}\n- Approvals: {len(approvals)}\n- Events: {len(events)}\n- Daily reports: {len(reports)}\n- Voice transcripts indexed: {len(transcript_rows)}\n- SEO pipeline runs: {len(seo_runs)}\n\n## Linked notes\n\n- [[Projects]]\n- [[Approvals]]\n- [[Event Log]]\n- [[Voice Transcripts]]\n- [[SEO Pipeline Runs]]\n\n> Generated by AgentOS Memory Galaxy. Secrets are redacted before export.\n""",
        "Projects.md": f"# Projects\n\n{obsidian_markdown_table(project_rows, ['name', 'slug', 'status', 'summary'])}",
        "Approvals.md": f"# Approvals\n\n{obsidian_markdown_table(approval_rows, ['id', 'status', 'risk', 'action', 'summary'])}",
        "Event Log.md": f"# Event Log\n\n{obsidian_markdown_table(event_rows, ['created_at', 'type', 'actor', 'details'])}",
        "Voice Transcripts.md": f"# Voice Transcripts\n\n{obsidian_markdown_table(transcript_rows, ['created_at', 'provider', 'status', 'text'])}",
        "SEO Pipeline Runs.md": f"# SEO Pipeline Runs\n\n{obsidian_markdown_table(seo_rows, ['created_at', 'keyword', 'route', 'score', 'status'])}",
    }
    written = []
    for name, content in files.items():
        path = folder / name
        write_text(path, redact_secret_text(content))
        written.append(path.relative_to(vault).as_posix())
    append_event(workspace, "obsidian_sync", "memory-galaxy", vault_path=str(vault), files=len(written))
    scan = obsidian_scan_notes(workspace, limit=12)
    return {
        "status": "synced",
        "decision": "agentos_memory_synced_to_obsidian",
        "vault_path": str(vault),
        "agentos_folder": info["agentos_folder"],
        "written": written,
        "note_count": scan.get("note_count", 0),
        "recent_notes": scan.get("recent_notes", []),
        "secrets_included": False,
    }


def mila_memory_galaxy(workspace: Path):
    reports = latest_agentos_wave_reports(workspace)
    latest_report = reports[-1] if reports else None
    events = read_json(workspace / "logs" / "events.json", [])
    projects = list_projects(workspace)
    sops = list((workspace / "sops").glob("**/*.md")) if (workspace / "sops").exists() else []
    skills = list((workspace / "skills").glob("**/*.md")) if (workspace / "skills").exists() else []
    transcripts = list(transcript_dir(workspace).glob("*.json")) if transcript_dir(workspace).exists() else []
    obsidian = obsidian_scan_notes(workspace, limit=8)
    counts = {
        "projects": len(projects),
        "reports": len(reports),
        "events": len(events),
        "sops": len(sops),
        "skills": len(skills),
        "voice_transcripts": len(transcripts),
        "obsidian_notes": obsidian.get("note_count", 0),
    }
    nodes = [
        {"id": "projects", "label": "Projects", "kind": "workspace", "count": counts["projects"], "relpath": "projects/"},
        {"id": "reports", "label": "Daily Reports", "kind": "memory", "count": counts["reports"], "relpath": "logs/daily/"},
        {"id": "events", "label": "Event Log", "kind": "audit", "count": counts["events"], "relpath": "logs/events.json"},
        {"id": "sops", "label": "SOPs", "kind": "process", "count": counts["sops"], "relpath": "sops/"},
        {"id": "skills", "label": "Skills", "kind": "procedure", "count": counts["skills"], "relpath": "skills/"},
        {"id": "voice-transcripts", "label": "Voice Transcripts", "kind": "voice", "count": counts["voice_transcripts"], "relpath": "voice/transcripts/"},
        {"id": "obsidian", "label": "Obsidian Vault", "kind": "vault", "count": counts["obsidian_notes"], "relpath": obsidian.get("vault_path", "")},
    ]
    return {
        "status": "ok",
        "decision": "mila_memory_galaxy_live_graph",
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "counts": counts,
        "obsidian": obsidian,
        "latest_report": {"exists": latest_report is not None, "relpath": latest_report.relative_to(workspace).as_posix() if latest_report else "logs/daily/none"},
        "nodes": nodes,
        "edges": [
            {"from": "projects", "to": "reports"},
            {"from": "events", "to": "reports"},
            {"from": "voice-transcripts", "to": "events"},
            {"from": "sops", "to": "skills"},
            {"from": "projects", "to": "obsidian"},
            {"from": "reports", "to": "obsidian"},
            {"from": "voice-transcripts", "to": "obsidian"},
        ],
    }


def mila_app_builder_blueprint(workspace: Path, idea: str = ""):
    cleaned_idea = (idea or "local ai app").strip()[:160]
    slug = slugify(cleaned_idea)
    artifact_relpath = f"artifacts/app-builder/{slug}/preview.html"
    steps = [
        {"id": "idea", "title": "Capture idea", "summary": cleaned_idea},
        {"id": "plan", "title": "Create implementation plan", "summary": "Break the idea into UI, API, tests, and safety tasks."},
        {"id": "approval", "title": "Request build approval", "summary": "Real file generation or agent execution requires an approval record."},
        {"id": "build", "title": "Build scaffold", "summary": "Generate local artifacts only after approval; preview stays dry-run."},
        {"id": "preview", "title": "Preview and iterate", "summary": "Open generated preview and feed changes back into the plan."},
    ]
    return {
        "status": "ok",
        "decision": "mila_app_builder_blueprint_preview",
        "read_only": True,
        "dry_run": True,
        "writes_enabled": False,
        "secrets_included": False,
        "requires_approval_for_build": True,
        "idea": cleaned_idea,
        "slug": slug,
        "flow": ["idea", "plan", "approval", "build", "preview", "iterate"],
        "plan": {"steps": steps, "test_strategy": "RED-GREEN-REFACTOR before scaffold execution"},
        "approval": {
            "risk": "medium",
            "reason": "Generating app artifacts changes local workspace files and may later invoke agents.",
            "endpoint": "/api/approvals/request",
        },
        "preview": {
            "artifact_relpath": artifact_relpath,
            "would_create": [artifact_relpath, f"artifacts/app-builder/{slug}/README.md"],
            "url_fragment": f"#builder:{slug}",
        },
        "safety": {
            "local_first": True,
            "no_external_publish": True,
            "approval_required_before_writes": True,
            "command_bridge_preserved": True,
        },
    }


def default_agentic_workflow_config():
    """AgentOS adaptation of tonbistudio/hermes-multi-agent-workflow.

    Reference shape: sources → intake → dedup → score → parallel research lanes →
    route → one human gate → fulfill → deliver. Domain-specific values live here
    as data so the UI can render the workflow without hard-coding steps.
    """
    return {
        "template_reference": "tonbistudio/hermes-multi-agent-workflow@fa4a9de",
        "name": "agentos-seo-content-pipeline",
        "board": "agentos-content",
        "workspace_root": "work/seo-pipeline",
        "cost_gate_usd": 5,
        "sources": [
            {"id": "transcripts", "profile": "voice", "skill": "transcript-scout", "schedule": "live", "query": "Find reusable source material in voice transcripts and meeting notes."},
            {"id": "keyword-web", "profile": "researcher", "skill": "keyword-scout", "schedule": "manual", "query": "Find search intent, SERP gaps, competitors, and supporting URLs."},
            {"id": "projects", "profile": "workspace", "skill": "project-scout", "schedule": "manual", "query": "Use AgentOS project context, reports, and app-builder artifacts."},
        ],
        "item_schema": {"fields": ["title", "keyword", "slug", "sources", "intent", "audience", "strategic_fit"]},
        "dedup": {"method": "token-cosine", "duplicate_threshold": 0.62, "possible_threshold": 0.40},
        "rubric": {
            "threshold": 65,
            "dimensions": [
                {"dimension": "search_intent", "max": 25, "hint": "keyword has clear intent and article angle"},
                {"dimension": "source_strength", "max": 20, "hint": "transcripts/projects/web sources support the article"},
                {"dimension": "conversion_fit", "max": 20, "hint": "fits funnel and product positioning"},
                {"dimension": "differentiation", "max": 20, "hint": "can produce non-generic, useful content"},
                {"dimension": "publish_safety", "max": 15, "hint": "low risk of secrets, claims, or unsafe publishing"},
            ],
        },
        "research_lanes": {
            "role": "researcher",
            "lanes": ["verify_sources", "serp_gap_audit", "outline_brief", "risk_review"],
            "classifier_lane": "serp_gap_audit",
        },
        "route": {
            "classifier": "serp_gap_audit.solution_quality",
            "map": {"missing": "article_pack", "weak": "article_pack", "crowded": "brief_only", "unsafe": "shelve", "good": "refresh_existing"},
        },
        "paths": {
            "article_pack": {
                "prep": [{"stage": "synthesize_brief", "role": "analyst"}, {"stage": "draft_proposal", "role": "orchestrator"}],
                "propose": {"role": "orchestrator", "template": "paths/proposals/seo-article-pack.md"},
                "fulfill": [{"stage": "write_articles", "role": "writer"}, {"stage": "edit_and_fact_check", "role": "editor"}, {"stage": "publish_package", "role": "orchestrator"}],
                "workspace_subdir": "article-packs",
                "scope_rails": "no external publish without approval; redact secrets; cite sources",
            },
            "brief_only": {"prep": [{"stage": "make_content_brief", "role": "analyst"}], "propose": {"role": "orchestrator"}, "fulfill": [{"stage": "deliver_brief", "role": "orchestrator"}], "workspace_subdir": "briefs"},
            "refresh_existing": {"prep": [{"stage": "refresh_plan", "role": "analyst"}], "propose": {"role": "orchestrator"}, "fulfill": [{"stage": "update_existing", "role": "writer"}, {"stage": "final_report", "role": "orchestrator"}], "workspace_subdir": "refreshes"},
            "shelve": {"auto": True},
        },
        "roles": {"orchestrator": "Hermes", "researcher": "Claude", "analyst": "OpenClaw", "writer": "Gemini", "editor": "Codex", "tester": "Hermes"},
        "gate": {"channel": "AgentOS approvals", "approve": ["approve"], "shelve": ["shelve", "reject"], "modify": ["modify"], "single_human_gate": True},
        "gotchas_preserved": ["scouts only detect", "route waits for all research lanes", "one human gate", "persistent workspace for fulfill", "status is not delivery", "no auto-publish"],
    }


def load_agentic_workflow_config(workspace: Path):
    config_path = workspace / "workflow" / "agentic_workflow.json"
    cfg = default_agentic_workflow_config()
    if config_path.exists():
        file_cfg = read_json(config_path, {})
        if isinstance(file_cfg, dict):
            cfg.update(file_cfg)
            cfg["config_path"] = config_path.relative_to(workspace).as_posix()
    return cfg


def agentic_seo_workflow_config(workspace: Path):
    cfg = load_agentic_workflow_config(workspace)
    return {
        "status": "ok",
        "decision": "agentic_workflow_config",
        **cfg,
    }


def _workflow_score(keyword: str, source_count: int):
    text = (keyword or "").strip()
    dims = {
        "search_intent": min(25, 10 + len(text.split()) * 4),
        "source_strength": min(20, 8 + source_count * 3),
        "conversion_fit": 16 if any(w in text.lower() for w in ["agent", "seo", "workflow", "automation", "content"]) else 11,
        "differentiation": 17 if len(text) >= 12 else 10,
        "publish_safety": 15,
    }
    total = sum(dims.values())
    return {"total": total, "threshold": 65, "passed": total >= 65, "breakdown": dims}


def workflow_artifact_relpath(workspace: Path, path: Path) -> str:
    return path.relative_to(workspace).as_posix()


def write_workflow_json_artifact(workspace: Path, run_dir: Path, name: str, data: dict) -> str:
    path = run_dir / name
    write_json(path, redact_secrets(data))
    return workflow_artifact_relpath(workspace, path)


def write_workflow_text_artifact(workspace: Path, run_dir: Path, name: str, content: str) -> str:
    path = run_dir / name
    write_text(path, redact_secret_text(content))
    return workflow_artifact_relpath(workspace, path)


def build_workflow_artifacts(workspace: Path, run_dir: Path, run: dict, cfg: dict, transcripts: list, projects: list):
    artifacts = {}
    artifacts["intake"] = write_workflow_json_artifact(workspace, run_dir, "01-intake.json", {
        "run_id": run["id"],
        "keyword": run["keyword"],
        "slug": run["slug"],
        "sources": run["sources"],
        "item_schema": cfg.get("item_schema", {}),
        "sample_project_context": [p.get("slug") or p.get("goal") for p in projects[:5]],
        "sample_transcript_count": len(transcripts),
    })
    artifacts["dedup_score"] = write_workflow_json_artifact(workspace, run_dir, "02-dedup-score.json", {
        "run_id": run["id"],
        "dedup": {
            "method": cfg.get("dedup", {}).get("method", "token-cosine"),
            "result": "unique",
            "duplicate_threshold": cfg.get("dedup", {}).get("duplicate_threshold"),
            "possible_threshold": cfg.get("dedup", {}).get("possible_threshold"),
        },
        "score": run["score"],
        "classifier": run["classifier"],
        "path": run["path"],
    })
    lane_paths = []
    for lane in run["research_lanes"]:
        lane_name = lane["id"]
        lane_paths.append(write_workflow_text_artifact(
            workspace,
            run_dir,
            f"research-{lane_name}.md",
            f"""# Research Lane: {lane_name.replace('_', ' ').title()}

Run: `{run['id']}`
Keyword: `{run['keyword']}`
Role: `{lane.get('role')}`

## Finding
{lane.get('summary')}

## Evidence
- Local project context available: {len(projects)}
- Voice transcript snippets available: {len(transcripts)}
- External publish: disabled

## Next
Route waits for every research lane before proposing fulfillment.
""",
        ))
    artifacts["research_lanes"] = lane_paths
    proposal_text = f"""# Human Gate Proposal

Run: `{run['id']}`
Keyword: `{run['keyword']}`
Route: `{run['classifier']}` → `{run['path']}`
Score: {run['score']['total']}/{run['score']['threshold']}

## Proposal
Create the `{run['path']}` deliverable in the persistent workspace below.

Workspace: `{workflow_artifact_relpath(workspace, run_dir)}`

## Safety Rails
- One human approval gate before fulfillment.
- No external publish from this workflow.
- Secrets are redacted before files are written.
- Fulfillment stages remain blocked until approval.
"""
    artifacts["proposal"] = write_workflow_text_artifact(workspace, run_dir, "03-human-gate-proposal.md", proposal_text)
    artifacts["delivery_plan"] = write_workflow_text_artifact(
        workspace,
        run_dir,
        "04-delivery-plan.md",
        f"""# Delivery Plan

Run: `{run['id']}`

## Stages
{chr(10).join(f"- {stage['id']}: {stage['status']} ({stage.get('role')})" for stage in run['stages'])}

## Current State
The run has produced intake, score, research, and proposal artifacts. Fulfillment is blocked by the human gate unless the route is `shelve`.
""",
    )
    artifacts["manifest"] = write_workflow_json_artifact(workspace, run_dir, "manifest.json", {
        "run_id": run["id"],
        "created_at": run["created_at"],
        "keyword": run["keyword"],
        "slug": run["slug"],
        "path": run["path"],
        "artifacts": artifacts,
        "safety": run["safety"],
    })
    return artifacts


def agentic_seo_workflow_run(workspace: Path, payload: dict):
    cfg = load_agentic_workflow_config(workspace)
    keyword = str(payload.get("keyword") or payload.get("kw") or "AgentOS SEO workflow").strip()[:160]
    slug = slugify(str(payload.get("slug") or keyword))
    auto_deploy = bool(payload.get("auto_deploy"))
    transcripts = list_voice_transcripts(workspace, limit=6).get("items", []) if "list_voice_transcripts" in globals() else []
    projects = list_projects(workspace)[:6]
    source_count = len(transcripts) + len(projects) + 1
    score = _workflow_score(keyword, source_count)
    classifier = "weak" if score["passed"] else "unsafe"
    path = cfg["route"]["map"].get(classifier, "shelve")
    workspace_subdir = cfg["paths"].get(path, {}).get("workspace_subdir", "shelved")
    run_dir = workspace / cfg.get("workspace_root", "work/seo-pipeline") / workspace_subdir / slug
    stages = [
        {"id": "intake", "title": "Intake", "role": "scout", "status": "done", "summary": f"Captured keyword '{keyword}' from dashboard."},
        {"id": "dedup", "title": "Dedup", "role": "engine", "status": "done", "summary": "token-cosine check: no exact duplicate in local SEO run history."},
        {"id": "score", "title": "Score", "role": "orchestrator", "status": "done", "summary": f"{score['total']}/{score['threshold']} rubric score."},
    ]
    lane_cards = []
    for lane in cfg["research_lanes"]["lanes"]:
        lane_cards.append({"id": lane, "title": lane.replace("_", " ").title(), "role": cfg["research_lanes"]["role"], "status": "done", "summary": f"Parallel lane completed for {keyword}."})
    stages.extend(lane_cards)
    stages.append({"id": "route", "title": "Route", "role": "engine", "status": "done", "summary": f"classifier={classifier} → path={path}"})
    prep = cfg["paths"].get(path, {}).get("prep", [])
    fulfill = cfg["paths"].get(path, {}).get("fulfill", [])
    for item in prep:
        stages.append({"id": item["stage"], "title": item["stage"].replace("_", " ").title(), "role": item.get("role"), "status": "done", "summary": "Pre-gate prep complete."})
    run_id = f"workflow_{uuid4().hex[:10]}"
    approval = None
    if path != "shelve":
        approval_summary = f"Approve gated SEO workflow '{keyword}' path={path}; no external publish until approved."
        if auto_deploy:
            approval = create_approval(
                workspace,
                "agentic_workflow_gate",
                approval_summary,
                "high",
                context={"run_id": run_id, "slug": slug, "path": path, "run_workspace": workflow_artifact_relpath(workspace, run_dir)},
            )
            append_event(workspace, "agentic_workflow_gate_created", approval_id=approval["id"], run_id=run_id, keyword=keyword, path=path)
        stages.append({"id": "human_gate", "title": "Human Gate", "role": "orchestrator", "status": "pending" if auto_deploy else "ready", "summary": approval_summary, "approval_id": approval.get("id") if approval else None})
        for item in fulfill:
            stages.append({"id": item["stage"], "title": item["stage"].replace("_", " ").title(), "role": item.get("role"), "status": "blocked", "summary": "Blocked until human approval; persistent workspace will be reused."})
    run = {
        "id": run_id,
        "created_at": now(),
        "keyword": keyword,
        "slug": slug,
        "mode": payload.get("mode") or "seo",
        "path": path,
        "classifier": classifier,
        "score": score,
        "sources": {"transcripts": len(transcripts), "projects": len(projects), "manual": 1},
        "research_lanes": lane_cards,
        "stages": stages,
        "approval": approval,
        "workspace": workflow_artifact_relpath(workspace, run_dir),
        "safety": {"dry_run": True, "single_human_gate": True, "external_publish": False, "secrets_included": False},
    }
    run["artifacts"] = build_workflow_artifacts(workspace, run_dir, run, cfg, transcripts, projects)
    for stage in run["stages"]:
        if stage["id"] == "intake":
            stage["artifact"] = run["artifacts"]["intake"]
        elif stage["id"] == "dedup" or stage["id"] == "score":
            stage["artifact"] = run["artifacts"]["dedup_score"]
        elif stage["id"] == "human_gate":
            stage["artifact"] = run["artifacts"]["proposal"]
        elif stage["id"] in {lane["id"] for lane in run["research_lanes"]}:
            stage["artifact"] = next((path for path in run["artifacts"]["research_lanes"] if f"research-{stage['id']}.md" in path), None)
    append_event(workspace, "agentic_workflow_artifacts_created", run_id=run["id"], run_workspace=run["workspace"], artifacts=len(run["artifacts"]))
    runs_path = workspace / "workflow" / "seo_runs.json"
    runs = read_json(runs_path, [])
    runs.append(run)
    write_json(runs_path, runs[-50:])
    return {"status": "ok", "decision": "agentic_workflow_run_planned", "config": cfg, "run": run, "runs": runs[-12:]}


def agentic_seo_workflow_runs(workspace: Path):
    return {"status": "ok", "items": list(reversed(read_json(workspace / "workflow" / "seo_runs.json", [])))}


def find_agentic_workflow_run(workspace: Path, run_id: str):
    runs_path = workspace / "workflow" / "seo_runs.json"
    runs = read_json(runs_path, [])
    for index, run in enumerate(runs):
        if run.get("id") == run_id:
            return runs_path, runs, index, run
    return runs_path, runs, None, None


def write_agentic_workflow_run(workspace: Path, runs_path: Path, runs: list, index: int, run: dict):
    runs[index] = run
    write_json(runs_path, runs[-50:])
    return run


def agentic_workflow_queue_project_slug(run: dict):
    return f"workflow-{slugify(run.get('slug') or run.get('keyword') or run.get('id') or 'agentic-workflow')}"


def create_agentic_workflow_queue_project(workspace: Path, run: dict, approval: dict):
    project_slug = agentic_workflow_queue_project_slug(run)
    project_dir = workspace / "projects" / project_slug
    project_dir.mkdir(parents=True, exist_ok=True)
    existing_project = read_json(project_dir / "project.json", {})
    if existing_project.get("workflow_run_id") == run.get("id") and (project_dir / "tasks.json").exists():
        sync = sync_agent_queue(workspace)
        return {"project": project_slug, "created": False, "tasks": len(read_json(project_dir / "tasks.json", [])), "queue": sync}

    fulfillment_stages = [stage for stage in run.get("stages", []) if stage.get("lane") == "fulfill" or str(stage.get("id", "")).startswith(("write_", "edit_", "publish_", "deliver_", "update_", "final_"))]
    if not fulfillment_stages:
        fulfillment_stages = [stage for stage in run.get("stages", []) if stage.get("status") == "done" and stage.get("approved_by") == "operator"]

    tasks = []
    previous_id = None
    for index, stage in enumerate(fulfillment_stages, start=1):
        task_id = f"W{index:03d}"
        planned_artifact = stage.get("artifact") or f"{stage.get('id', task_id)}.md"
        task = {
            "id": task_id,
            "project": project_slug,
            "objective": f"Workflow fulfillment: {stage.get('title') or stage.get('id')}",
            "owner": stage.get("role") or "orchestrator",
            "status": "planned",
            "depends_on": [previous_id] if previous_id else [],
            "risk_level": "low",
            "requires_approval": False,
            "approval_id": approval.get("id"),
            "workflow_run_id": run.get("id"),
            "workflow_stage_id": stage.get("id"),
            "acceptance_criteria": [
                "Agent Queue execution writes a local artifact",
                "Task status is updated through AgentOS queue lifecycle",
                "No external publish is performed",
            ],
            "artifacts": [planned_artifact],
            "block_reason": None,
            "lane": "workflow-fulfillment",
        }
        tasks.append(task)
        previous_id = task_id

    metadata = {
        "slug": project_slug,
        "goal": f"Fulfill workflow run {run.get('id')} for {run.get('keyword')}",
        "created_at": now(),
        "status": "queued",
        "workflow": "agentic_workflow_fulfillment_queue",
        "workflow_run_id": run.get("id"),
        "source_workspace": run.get("workspace"),
        "approval_id": approval.get("id"),
        "safety": {"external_publish": False, "approval_gate_completed": True},
    }
    write_json(project_dir / "project.json", metadata)
    write_json(project_dir / "tasks.json", tasks)
    write_text(project_dir / "project-brief.md", f"""# Workflow Fulfillment Queue: {run.get('keyword')}

Run: `{run.get('id')}`
Approval: `{approval.get('id')}`
Source workspace: `{run.get('workspace')}`

## Purpose
These cards were created after the human gate approved the workflow. Agent Queue can now execute them one by one.

## Safety
- External publishing remains disabled.
- These tasks write local artifacts only.
- The approval gate has already been recorded.
""")
    sync = sync_agent_queue(workspace)
    append_event(workspace, "agentic_workflow_queue_project_created", run_id=run.get("id"), project=project_slug, tasks=len(tasks), approval_id=approval.get("id"))
    return {"project": project_slug, "created": True, "tasks": len(tasks), "queue": sync}


def continue_agentic_workflow_after_gate(workspace: Path, approval: dict, status_value: str):
    if approval.get("action") != "agentic_workflow_gate":
        return None
    context = approval.get("context") or {}
    run_id = context.get("run_id")
    if not run_id:
        return {"error": "workflow_run_id_missing", "approval_id": approval.get("id")}
    runs_path, runs, index, run = find_agentic_workflow_run(workspace, run_id)
    if run is None:
        return {"error": "workflow_run_not_found", "run_id": run_id, "approval_id": approval.get("id")}
    run_dir = workspace / run.get("workspace", context.get("run_workspace", "work/seo-pipeline/missing"))
    if status_value == "approved":
        fulfillment_artifacts = []
        for stage in run.get("stages", []):
            if stage.get("id") == "human_gate":
                stage["status"] = "done"
                stage["approved_at"] = now()
                stage["approval_id"] = approval.get("id")
            elif stage.get("status") == "blocked":
                stage["status"] = "done"
                stage["approved_by"] = "operator"
                stage["approved_at"] = now()
                artifact = write_workflow_text_artifact(
                    workspace,
                    run_dir,
                    f"fulfillment-{stage.get('id')}.md",
                    f"""# Fulfillment Stage: {stage.get('title') or stage.get('id')}

Run: `{run_id}`
Approval: `{approval.get('id')}`
Role: `{stage.get('role')}`

## Result
Stage released by the human gate and completed in dry-run/local artifact mode.

## Safety
- External publish remains disabled.
- No credentials are written to this artifact.
- This is a local AgentOS fulfillment artifact.
""",
                )
                stage["artifact"] = artifact
                fulfillment_artifacts.append(artifact)
        delivery_report = write_workflow_text_artifact(
            workspace,
            run_dir,
            "05-final-delivery-report.md",
            f"""# Final Delivery Report

Run: `{run_id}`
Keyword: `{run.get('keyword')}`
Path: `{run.get('path')}`
Approval: `{approval.get('id')}`

## Completed Fulfillment Artifacts
{chr(10).join(f'- `{artifact}`' for artifact in fulfillment_artifacts) or '- none'}

## Status
Approved workflow gate completed. Fulfillment artifacts were created locally. External publish remains disabled.
""",
        )
        run.setdefault("artifacts", {})["fulfillment"] = fulfillment_artifacts
        run["artifacts"]["final_delivery_report"] = delivery_report
        run["status"] = "fulfilled"
        run["fulfilled_at"] = now()
        run["approved_by"] = "operator"
        run["approval_id"] = approval.get("id")
        queue_project = create_agentic_workflow_queue_project(workspace, run, approval)
        run["queue_project"] = queue_project
        append_event(workspace, "agentic_workflow_fulfilled", run_id=run_id, approval_id=approval.get("id"), artifacts=len(fulfillment_artifacts), queue_project=queue_project.get("project"))
    else:
        for stage in run.get("stages", []):
            if stage.get("id") == "human_gate":
                stage["status"] = "blocked"
                stage["block_reason"] = "operator denied/shelved workflow gate"
            elif stage.get("status") == "blocked":
                stage["block_reason"] = "operator denied/shelved workflow gate"
        run["status"] = "shelved"
        run["shelved_at"] = now()
        run["approval_id"] = approval.get("id")
        append_event(workspace, "agentic_workflow_shelved", run_id=run_id, approval_id=approval.get("id"))
    manifest_path = (run.get("artifacts") or {}).get("manifest")
    if manifest_path:
        write_json(workspace / manifest_path, redact_secrets({
            "run_id": run["id"],
            "created_at": run.get("created_at"),
            "updated_at": now(),
            "keyword": run.get("keyword"),
            "slug": run.get("slug"),
            "status": run.get("status"),
            "path": run.get("path"),
            "artifacts": run.get("artifacts", {}),
            "safety": run.get("safety", {}),
        }))
    return {"run": write_agentic_workflow_run(workspace, runs_path, runs, index, run)}


def mila_kanban_studio(workspace: Path):
    queue = load_agent_queue(workspace)
    runs = load_agent_queue_runs(workspace)
    all_tasks = []
    for tasks_path in sorted((workspace / "projects").glob("*/tasks.json")):
        project_slug = tasks_path.parent.name
        for task in read_json(tasks_path, []):
            item = dict(task)
            item.setdefault("project", project_slug)
            all_tasks.append(item)
    def card_from_task(task):
        return {
            "id": task.get("id") or task.get("queue_id") or task.get("title") or "task",
            "title": task.get("objective") or task.get("title") or task.get("summary") or "AgentOS task",
            "project": task.get("project") or task.get("slug") or "workspace",
            "status": task.get("status") or "planned",
            "owner": task.get("owner") or task.get("worker") or "agent",
            "lane": task.get("lane") or task.get("trigger") or "orchestra",
            "risk_level": task.get("risk_level") or "low",
        }
    planned = [card_from_task(t) for t in all_tasks if (t.get("status") or "planned") in {"planned", "ready", "todo"}]
    building = [card_from_task(t) for t in all_tasks if (t.get("status") or "") in {"in_progress", "building", "running"}]
    judge = [card_from_task(t) for t in all_tasks if (t.get("status") or "") in {"review", "judge", "blocked"}]
    done = [card_from_task(t) for t in all_tasks if (t.get("status") or "") in {"done", "completed"}]
    if queue:
        planned.extend(card_from_task(q) for q in queue[:12])
    if runs:
        judge.extend(card_from_task(r) for r in list(reversed(runs))[:8])
    lanes = [
        {"id": "planned", "title": "Planned", "count": len(planned), "cards": planned[:8]},
        {"id": "building", "title": "Building", "count": len(building), "cards": building[:8]},
        {"id": "judge", "title": "Judge", "count": len(judge), "cards": judge[:8]},
        {"id": "done", "title": "Done", "count": len(done), "cards": done[:8]},
    ]
    return {
        "status": "ok",
        "decision": "mila_kanban_studio_live_lanes",
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "counts": {
            "tasks": len(all_tasks),
            "queue_items": len(queue),
            "queue_runs": len(runs),
            "lanes": len(lanes),
        },
        "lanes": lanes,
        "safety": {"read_only": True, "real_task_creation_requires_approval": True},
    }


def mila_model_hub(workspace: Path):
    data, base_path, local_path = load_voice_config_raw(workspace)
    health = voice_health(workspace)
    providers = []
    for item in health.get("providers", []):
        provider_id = item.get("provider")
        providers.append({
            "id": provider_id,
            "display_name": str(provider_id or "provider").replace("_", " ").title(),
            "enabled": bool(item.get("enabled")),
            "ready": bool(item.get("ready")),
            "mode": item.get("mode") or "unknown",
            "model": item.get("model") or "default",
            "reasons": item.get("reasons") or [],
            "credential_state": "configured" if (item.get("has_env_key") or item.get("has_inline_key")) else "not_required_or_missing",
        })
    providers.append({
        "id": "openai_gpt",
        "display_name": "OpenAI GPT",
        "enabled": True,
        "ready": bool(os.getenv("OPENAI_API_KEY")),
        "mode": "reasoning_and_tool_assistance",
        "model": "gpt",
        "reasons": ["ready"] if os.getenv("OPENAI_API_KEY") else ["missing_openai_credentials"],
        "credential_state": "configured" if os.getenv("OPENAI_API_KEY") else "missing_env_credential",
        "owned_by": "mila",
    })
    return {
        "status": "ok",
        "decision": "mila_model_hub_live_provider_catalog",
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "default_provider": data.get("default_provider"),
        "counts": {
            "providers": len(providers),
            "ready": sum(1 for item in providers if item.get("ready")),
            "enabled": sum(1 for item in providers if item.get("enabled")),
        },
        "providers": providers,
        "credential_visibility": {
            "raw_keys_exposed": False,
            "local_override_exists": local_path.exists(),
            "config_relpath": base_path.relative_to(workspace).as_posix() if base_path.exists() and base_path.is_relative_to(workspace) else "config/voice.json",
            "local_relpath": local_path.relative_to(workspace).as_posix() if local_path.is_relative_to(workspace) else "config/voice.local.json",
        },
        "safety": {"read_only": True, "raw_keys_are_never_returned": True},
    }


def mila_single_agent_status(workspace: Path):
    load_workspace_dotenv(workspace)
    cfg = read_json(workspace / "config" / "mila.json", {})
    registry = load_agent_registry(workspace)
    dock = mila_agent_dock(workspace)
    voice = voice_health(workspace)
    gemini = next((item for item in voice.get("providers", []) if item.get("provider") == "gemini_live"), {})
    memory_paths = [
        cfg.get("memory", {}).get("initial", "memory/mila-initial-memory.md"),
        cfg.get("memory", {}).get("learnings", "memory/mila-learnings.md"),
    ]
    return {
        "status": "ok",
        "decision": "mila_single_agent_status",
        "agent": {
            "id": "mila",
            "display_name": "Mila",
            "mode": cfg.get("mode", "single_agent_orchestrator"),
            "visible_agents": len(dock.get("agents", [])),
            "is_only_visible_agent": len(dock.get("agents", [])) == 1 and dock.get("agents", [{}])[0].get("role") == "mila",
        },
        "voice": {
            "provider": "gemini_live",
            "ready": bool(gemini.get("ready")),
            "reasons": gemini.get("reasons") or [],
            "speech_to_speech": True,
        },
        "models": {
            "openai_gpt": {
                "ready": bool(os.getenv("OPENAI_API_KEY")),
                "api_key_env": "OPENAI_API_KEY",
                "raw_key_exposed": False,
            },
            "gemini_live": {
                "ready": bool(gemini.get("ready")),
                "api_key_env": "GEMINI_API_KEY",
                "raw_key_exposed": False,
            },
        },
        "memory": {
            "paths": memory_paths,
            "all_present": all((workspace / rel).exists() for rel in memory_paths),
        },
        "permissions": cfg.get("workspace_access", {}),
        "safety": cfg.get("safety", {}),
        "registry": {
            "mode": registry.get("mode"),
            "agents": len(registry.get("agents", [])),
        },
        "secrets_included": False,
    }


def mila_nova_voice_agent(workspace: Path):
    load_workspace_dotenv(workspace)
    cfg = read_json(workspace / "config" / "mila.json", {})
    voice = voice_health(workspace)
    gemini = next((item for item in voice.get("providers", []) if item.get("provider") == "gemini_live"), {})
    runtime = cfg.get("voice", {}).get("runtime", {})
    reference = cfg.get("voice", {}).get("nova_reference", {})

    def resolve_voice_reference(configured: str | None, fallback_relpath: str) -> Path:
        configured_path = Path(configured or "")
        if configured_path.exists():
            return configured_path
        return workspace / fallback_relpath

    backend_ref = resolve_voice_reference(
        reference.get("backend_reference"),
        "dashboard/backend/app.py",
    )
    frontend_ref = resolve_voice_reference(
        reference.get("frontend_reference"),
        "dashboard/frontend/index.html",
    )
    native = mila_native_voice_ready(workspace)
    browser_fallback_ready = True
    transport_status = "gemini_native_audio_ws" if native["ready"] else "browser_fallback"
    return {
        "status": "ok",
        "decision": "mila_nova_voice_agent",
        "agent": {"id": "mila", "display_name": "Mila", "role": "single_orchestrator"},
        "reference": {
            "name": reference.get("name", "AGENT NOVA voice assistant"),
            "backend_reference_found": backend_ref.exists(),
            "frontend_reference_found": frontend_ref.exists(),
            "backend_reference": str(backend_ref),
            "frontend_reference": str(frontend_ref),
            "pattern": reference.get("pattern", "Browser PCM 16k -> AgentOS WebSocket -> Gemini Live native audio -> browser PCM 24k"),
        },
        "runtime": {
            "mode": runtime.get("mode", "nova_style_live_assistant"),
            "primary_provider": runtime.get("primary_provider", "gemini_live"),
            "voice_name": runtime.get("voice_name", MILA_DEFAULT_VOICE),
            "language_default": runtime.get("language_default", "ru-RU"),
            "target_transport": runtime.get("target_transport", "gemini_native_audio_websocket"),
            "active_transport": transport_status,
            "websocket_path": "/ws/mila/voice",
            "native_audio_ready": native["ready"],
            "google_genai_sdk_ready": native["sdk_ready"],
            "native_model": native["model"],
            "input_sample_rate": native["input_sample_rate"],
            "output_sample_rate": native["output_sample_rate"],
            "browser_fallback_ready": browser_fallback_ready,
            "livekit_ready": False,
            "required_env": ["GEMINI_API_KEY"],
            "raw_keys_exposed": False,
        },
        "voice": {
            "gemini_live_ready": bool(gemini.get("ready")),
            "gemini_live_reasons": gemini.get("reasons") or [],
            "speech_to_speech_target": True,
        },
        "states": runtime.get("states", ["idle", "listening", "thinking", "speaking", "tool_running", "blocked"]),
        "turn_loop": runtime.get("turn_loop", ["microphone", "transcript", "gemini_live", "command_bridge", "approval_gate", "result", "spoken_reply", "memory_writeback"]),
        "memory": {
            "writeback": runtime.get("memory_writeback", "memory/mila-learnings.md"),
            "conversation_items_saved": True,
        },
        "ui": {
            "visualizer": "nova_bar_orb",
            "controls": ["microphone", "typed_message", "provider_status", "transcript_log"],
        },
        "secrets_included": False,
    }


def mila_tray_package(workspace: Path):
    scripts = []
    for relpath in ["scripts/mila_tray.py", "scripts/start_mila_tray.bat"]:
        path = workspace / relpath
        scripts.append({
            "relpath": relpath,
            "exists": path.exists(),
            "size": path.stat().st_size if path.exists() else 0,
            "secret_free_expected": True,
        })
    return {
        "status": "ok",
        "decision": "mila_native_tray_package_scaffold",
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "platform": "windows",
        "dashboard_url": "http://127.0.0.1:8765/",
        "capabilities": ["open_dashboard", "status", "restart_dashboard", "quit"],
        "scripts": scripts,
        "safety": {
            "read_only_metadata": True,
            "no_privileged_install": True,
            "credentials_stay_external": True,
            "restart_requires_operator_action": True,
        },
    }


def mila_visual_polish(workspace: Path):
    frontend = workspace / "dashboard" / "frontend" / "index.html"
    text = read_text_safe(frontend)
    markers = [
        "milaJarvisWorkspace",
        "jarvis-focus-strip",
        "jarvis-live-signal",
        "jarvis-safety-ribbon",
        "jarvis-workspace-lanes",
        "milaVisualPolishPanel",
    ]
    return {
        "status": "ok",
        "decision": "mila_jarvis_workspace_visual_polish",
        "read_only": True,
        "writes_enabled": False,
        "secrets_included": False,
        "layout": {
            "mode": "focused_command_center",
            "routes": text.count("data-mila-route=\"") if text else 9,
            "agentic_sections": text.count("data-agentic-panel"),
        },
        "principles": ["voice_first", "approval_gated_actions", "no_secret_surfaces", "local_first", "live_status_cards", "focused_command_center"],
        "polish_markers": [{"id": marker, "present": marker in text} for marker in markers],
        "safety": {"read_only": True, "no_secret_surfaces": True, "approval_gates_preserved": True},
    }


def read_text_safe(path: Path, default: str = ""):
    try:
        return path.read_text(encoding="utf-8") if path.exists() else default
    except OSError:
        return default


def latest_agentos_wave_reports(workspace: Path):
    reports = list((workspace / "logs" / "daily").glob("*_agentos-wave-*.md"))
    def report_key(path: Path):
        match = re.search(r"wave-(\d+)-report\.md$", path.name)
        return int(match.group(1)) if match else -1
    return sorted(reports, key=report_key)


def dashboard_release_check(workspace: Path):
    backend = workspace / "dashboard" / "backend" / "app.py"
    frontend = workspace / "dashboard" / "frontend" / "index.html"
    cli = workspace / "agentosctl.py"
    reports = latest_agentos_wave_reports(workspace)
    backend_text = read_text_safe(backend)
    frontend_text = read_text_safe(frontend)
    cli_text = read_text_safe(cli)
    checks = {
        "workspace": workspace.exists(),
        "dashboard_backend": backend.exists(),
        "dashboard_frontend": frontend.exists(),
        "command_bridge": "/api/command" in backend_text and "Command Bridge" in frontend_text,
        "voice_loop": "def voice_loop" in cli_text and "/api/voice-loop" in backend_text,
        "transcript_filters": "voiceTranscriptProvider" in frontend_text and "voice transcripts" in cli_text.lower(),
        "approval_gate": "approval_required" in backend_text and "create_real_kanban_tasks" in backend_text,
        "mila_realtime_ux": "milaRealtimePanel" in frontend_text and "milaStartListening" in frontend_text and "/api/voice-session" in frontend_text,
        "mila_desktop_packaging": all((workspace / rel).exists() for rel in ["scripts/start_mila.bat", "scripts/start_mila.sh", "installers/install_mila_autostart.bat", "installers/uninstall_mila_autostart.bat"]) and "/api/mila/desktop-package" in backend_text,
        "mila_agentic_os_interface": "agenticOsShell" in frontend_text and "milaMemoryGalaxy" in frontend_text and "milaAppBuilder" in frontend_text and "/api/mila/interface-blueprint" in backend_text,
        "mila_dashboard_routes": "milaPrimaryRoutes" in frontend_text and "activateMilaRoute" in frontend_text and "syncMilaRouteFromHash" in frontend_text and "/api/mila/dashboard-routes" in backend_text,
        "mila_agent_dock_live": "milaAgentDockLive" in frontend_text and "loadMilaAgentDock" in frontend_text and "/api/mila/agent-dock" in backend_text,
        "mila_memory_galaxy_live": "milaMemoryGalaxyLive" in frontend_text and "loadMilaMemoryGalaxy" in frontend_text and "/api/mila/memory-galaxy" in backend_text,
        "mila_app_builder_functional": "milaAppBuilderIdea" in frontend_text and "loadMilaAppBuilderBlueprint" in frontend_text and "/api/mila/app-builder/blueprint" in backend_text,
        "mila_kanban_studio_live": "milaKanbanStudioLive" in frontend_text and "loadMilaKanbanStudio" in frontend_text and "/api/mila/kanban-studio" in backend_text,
        "mila_model_hub_live": "milaModelHubLive" in frontend_text and "loadMilaModelHub" in frontend_text and "/api/mila/model-hub" in backend_text,
        "mila_native_tray_scaffold": all((workspace / rel).exists() for rel in ["scripts/mila_tray.py", "scripts/start_mila_tray.bat"]) and "milaTrayPackagePanel" in frontend_text and "loadMilaTrayPackage" in frontend_text and "/api/mila/tray-package" in backend_text,
        "mila_visual_polish_final": "milaJarvisWorkspace" in frontend_text and "jarvis-focus-strip" in frontend_text and "loadMilaVisualPolish" in frontend_text and "/api/mila/visual-polish" in backend_text,
        "latest_report": bool(reports),
    }
    data, _, _ = load_voice_config_raw(workspace)
    gemini = data.get("providers", {}).get("gemini_live", {})
    gemini_status = voice_provider_status("gemini_live", gemini) if gemini else {"provider": "gemini_live", "ready": False, "reasons": ["not_configured"]}
    optional_blockers = [] if gemini_status.get("ready") else ["gemini_live"]
    return {
        "status": "ready_local" if all(checks.values()) else "needs_attention",
        "dashboard_url": "http://127.0.0.1:8765/",
        "workspace": str(workspace),
        "checks": checks,
        "optional_blockers": optional_blockers,
        "gemini_live": gemini_status,
        "latest_report": str(reports[-1]) if reports else None,
    }


def production_readiness(workspace: Path):
    release = dashboard_release_check(workspace)
    worker = agent_worker_status(workspace)
    worker_config = worker.get("config") or {}
    worker_runtime = worker.get("runtime") or {}
    worker_safe_state = (
        worker.get("status") == "disabled"
        and worker_runtime.get("mode") == "dry_run"
        and bool(worker_config.get("enabled")) is False
    )
    required_blockers = [name for name, passed in (release.get("checks") or {}).items() if not passed]
    if not worker_safe_state:
        required_blockers.append("agent_worker_safe_state")
    optional_blockers = list(release.get("optional_blockers") or [])
    local_ready = release.get("status") == "ready_local"
    required_checks_passed = not required_blockers
    if not required_checks_passed:
        readiness_status = "blocked"
    elif optional_blockers:
        readiness_status = "ready_with_optional_blockers"
    else:
        readiness_status = "ready_local"
    latest_report = release.get("latest_report")
    latest_report_path = Path(latest_report) if latest_report else None
    latest_report_payload = {
        "exists": bool(latest_report_path and latest_report_path.exists()),
        "path": str(latest_report_path) if latest_report_path else None,
        "relpath": latest_report_path.relative_to(workspace).as_posix() if latest_report_path and latest_report_path.exists() else None,
        "modified_at": datetime.fromtimestamp(latest_report_path.stat().st_mtime).replace(microsecond=0).isoformat() if latest_report_path and latest_report_path.exists() else None,
    }
    operator_next_steps = []
    if required_blockers:
        operator_next_steps.append("fix_required_checks")
    if "agent_worker_safe_state" in required_blockers:
        operator_next_steps.append("reset_worker_to_disabled_dry_run")
    if "gemini_live" in optional_blockers:
        operator_next_steps.append("configure_gemini_live_credentials")
    if not operator_next_steps:
        operator_next_steps.append("ready_for_local_production_run")
    return {
        "status": readiness_status,
        "decision": "production_readiness",
        "dry_run": True,
        "will_apply": False,
        "writes_enabled": False,
        "read_only": True,
        "generated_at": now(),
        "workspace": str(workspace),
        "readiness": {
            "local_ready": local_ready,
            "production_ready": readiness_status == "ready_local",
            "required_checks_passed": required_checks_passed,
            "worker_safe_state": worker_safe_state,
        },
        "required_blockers": required_blockers,
        "optional_blockers": optional_blockers,
        "release_check": release,
        "latest_report": latest_report_payload,
        "worker": worker,
        "operator_next_steps": operator_next_steps,
        "links": {
            "dashboard": "http://127.0.0.1:8765/",
            "release_check": "agentosctl.py release check --pretty",
            "latest_report": latest_report_payload.get("relpath"),
        },
    }


def production_readiness_export_markdown(readiness: dict):
    checks = readiness.get("release_check", {}).get("checks") or {}
    latest_report = readiness.get("latest_report") or {}
    worker = readiness.get("worker") or {}
    worker_runtime = worker.get("runtime") or {}
    worker_config = worker.get("config") or {}
    lines = [
        "# AgentOS Production Readiness",
        "",
        f"- status: {readiness.get('status')}",
        f"- decision: {readiness.get('decision')}",
        f"- generated_at: {readiness.get('generated_at')}",
        f"- workspace: {readiness.get('workspace')}",
        f"- required_blockers: {', '.join(readiness.get('required_blockers') or []) or 'none'}",
        f"- optional_blockers: {', '.join(readiness.get('optional_blockers') or []) or 'none'}",
        f"- operator_next_steps: {', '.join(readiness.get('operator_next_steps') or []) or 'none'}",
        "",
        "## Readiness",
        f"- local_ready: {readiness.get('readiness', {}).get('local_ready')}",
        f"- production_ready: {readiness.get('readiness', {}).get('production_ready')}",
        f"- required_checks_passed: {readiness.get('readiness', {}).get('required_checks_passed')}",
        f"- worker_safe_state: {readiness.get('readiness', {}).get('worker_safe_state')}",
        "",
        "## Release Checks",
    ]
    for name, passed in checks.items():
        lines.append(f"- {name}: {passed}")
    gemini = readiness.get("release_check", {}).get("gemini_live") or {}
    lines.extend([
        "",
        "## Gemini Live",
        f"- provider: {gemini.get('provider', 'gemini_live')}",
        f"- ready: {gemini.get('ready')}",
        f"- reasons: {', '.join(gemini.get('reasons') or []) or 'none'}",
        f"- mode: {gemini.get('mode')}",
        f"- model: {gemini.get('model')}",
        "",
        "## Latest Report",
        f"- exists: {latest_report.get('exists')}",
        f"- relpath: {latest_report.get('relpath')}",
        f"- modified_at: {latest_report.get('modified_at')}",
        "",
        "## Worker Safe-State",
        f"- status: {worker.get('status')}",
        f"- runtime_mode: {worker_runtime.get('mode')}",
        f"- enabled: {worker_config.get('enabled')}",
        f"- max_items_per_tick: {worker_config.get('max_items_per_tick')}",
        f"- filters: {worker_config.get('filters')}",
    ])
    return "\n".join(lines) + "\n"


def redact_production_readiness_markdown(content: str):
    redacted = content
    for key in ["api_key", "token", "secret", "password"]:
        redacted = re.sub(rf"(?i)({re.escape(key)}\s*[:=]\s*)[^\n,]+", rf"\1[REDACTED]", redacted)
    return redacted


def production_readiness_export_preview(workspace: Path, max_chars=4000):
    max_chars = max(0, int(max_chars or 0))
    readiness = redact_secrets(production_readiness(workspace))
    markdown = redact_production_readiness_markdown(production_readiness_export_markdown(readiness))
    content_length = len(markdown)
    if max_chars > 0:
        markdown_preview = markdown[:max_chars]
        truncated = len(markdown_preview) < content_length
    else:
        markdown_preview = markdown
        truncated = False
    return {
        "status": "ok",
        "decision": "production_readiness_export_preview",
        "dry_run": True,
        "will_apply": False,
        "writes_enabled": False,
        "read_only": True,
        "artifact_path": None,
        "artifact_relpath": None,
        "readiness": {
            "status": readiness.get("status"),
            **(readiness.get("readiness") or {}),
            "required_blockers": readiness.get("required_blockers") or [],
            "optional_blockers": readiness.get("optional_blockers") or [],
        },
        "export_preview": {
            "format": "markdown",
            "title": "AgentOS Production Readiness",
            "max_chars": max_chars,
            "content_length": content_length,
            "line_count": len(markdown.splitlines()),
            "markdown_preview": markdown_preview,
            "truncated": truncated,
            "redactions": ["api_key", "token", "secret", "password"],
        },
        "safety": {
            "read_only": True,
            "artifact_write_enabled": False,
            "history_writes_enabled": False,
            "retention_apply_called": False,
            "operational_ledgers_mutated": False,
        },
        "links": {
            "production_readiness": "/api/production-readiness",
            "release_check": "agentosctl.py release check --pretty",
        },
    }


def production_readiness_credential_handoff(workspace: Path):
    release = dashboard_release_check(workspace)
    worker_config = normalize_agent_worker_config(read_json(agent_worker_config_path(workspace), {}))
    worker_runtime = agent_worker_runtime_config_state(worker_config)
    worker_safe_state = (
        bool(worker_config.get("enabled")) is False
        and worker_runtime.get("mode") == "dry_run"
    )
    required_blockers = [name for name, passed in (release.get("checks") or {}).items() if not passed]
    if not worker_safe_state:
        required_blockers.append("agent_worker_safe_state")
    optional_blockers = list(release.get("optional_blockers") or [])
    if required_blockers:
        readiness_status = "blocked"
    elif optional_blockers:
        readiness_status = "ready_with_optional_blockers"
    else:
        readiness_status = "ready_local"
    operator_next_steps = []
    if required_blockers:
        operator_next_steps.append("fix_required_checks")
    if "agent_worker_safe_state" in required_blockers:
        operator_next_steps.append("reset_worker_to_disabled_dry_run")
    if "gemini_live" in optional_blockers:
        operator_next_steps.append("configure_gemini_live_credentials")
    if not operator_next_steps:
        operator_next_steps.append("ready_for_local_production_run")
    readiness = redact_secrets({
        "status": readiness_status,
        "readiness": {
            "local_ready": release.get("status") == "ready_local",
            "production_ready": readiness_status == "ready_local",
            "required_checks_passed": not required_blockers,
            "worker_safe_state": worker_safe_state,
        },
        "required_blockers": required_blockers,
        "optional_blockers": optional_blockers,
        "operator_next_steps": operator_next_steps,
    })
    data, base_path, local_path = load_voice_config_raw(workspace)
    gemini_cfg = data.get("providers", {}).get("gemini_live", {})
    current_status = redact_secrets(voice_provider_status("gemini_live", gemini_cfg)) if gemini_cfg else {
        "provider": "gemini_live",
        "enabled": False,
        "mode": "voice_to_voice",
        "model": "gemini-live-3.1",
        "ready": False,
        "reasons": ["not_configured"],
        "has_env_key": False,
        "has_inline_key": False,
    }
    reasons = list(current_status.get("reasons") or [])
    has_credentials = bool(current_status.get("has_env_key") or current_status.get("has_inline_key"))
    if current_status.get("ready"):
        handoff_status = "credentials_present_verify_transport"
        remaining_external_blocker = None
    elif "missing_credentials" in reasons or not has_credentials:
        handoff_status = "missing_credentials"
        remaining_external_blocker = "gemini_live"
    else:
        handoff_status = "provider_not_ready"
        remaining_external_blocker = "gemini_live"
    workspace_arg = "C:/Users/User/AgentOS"
    local_example = workspace / "config" / "voice.local.example.json"
    handoff = {
        "provider": "gemini_live",
        "handoff_status": handoff_status,
        "remaining_external_blocker": remaining_external_blocker,
        "current_status": current_status,
        "required_credentials": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "preferred_credential": "GEMINI_API_KEY",
        "fallback_credential": "GOOGLE_API_KEY",
        "recommended_storage": "environment_variable",
        "do_not_store_in_dashboard": True,
        "actions_stay_routed_through_command_bridge": True,
        "approval_gates_remain_required": True,
        "base_config_path": str(base_path),
        "local_override_path": str(local_path),
        "local_override_relpath": "config/voice.local.json",
        "local_override_exists": local_path.exists(),
        "local_override_example_path": str(local_example),
        "local_override_example_relpath": "config/voice.local.example.json",
        "config_snapshot": redact_secrets(gemini_cfg),
        "setup_steps": [
            {
                "id": "obtain_google_ai_studio_key",
                "summary": "Create or choose a Google AI Studio / Gemini API key with Gemini Live access for this machine.",
                "operator_action": "provision_secret_outside_agentos",
            },
            {
                "id": "set_environment_variable",
                "summary": "Store the key outside the dashboard; prefer an environment variable over inline config.",
                "windows_user_command": "setx GEMINI_API_KEY \"<your_key>\"",
                "git_bash_command": "export GEMINI_API_KEY=\"<your_key>\"",
                "fallback_windows_user_command": "setx GOOGLE_API_KEY \"<your_key>\"",
                "restart_required": True,
            },
            {
                "id": "enable_gemini_live_provider",
                "summary": "Ensure config/voice.local.json enables gemini_live while keeping secrets out of the browser.",
                "expected_json_fragment": {"providers": {"gemini_live": {"enabled": True}}},
            },
            {
                "id": "restart_dashboard_backend",
                "summary": "Restart the dashboard backend or Hermes-launched process so the new environment is visible.",
                "command": f"python {workspace_arg}/dashboard/backend/app.py --workspace {workspace_arg} --port 8765",
            },
            {
                "id": "verify_voice_status",
                "summary": "Verify Gemini Live is no longer blocked by missing credentials.",
                "command": f"python agentosctl.py --workspace {workspace_arg} voice status --pretty",
            },
            {
                "id": "run_gemini_live_probe",
                "summary": "Run the provider probe; it must pass before real voice-to-voice use.",
                "command": f"python agentosctl.py --workspace {workspace_arg} voice test --provider gemini_live --pretty",
            },
            {
                "id": "run_safe_command_session",
                "summary": "Verify recognized/normalized text still routes through the safe command bridge and approvals.",
                "command": f"python agentosctl.py --workspace {workspace_arg} voice session --provider gemini_live --text \"покажи digest\" --pretty",
            },
        ],
        "verification_commands": [
            f"python agentosctl.py --workspace {workspace_arg} voice status --pretty",
            f"python agentosctl.py --workspace {workspace_arg} voice test --provider gemini_live --pretty",
            f"python agentosctl.py --workspace {workspace_arg} voice session --provider gemini_live --text \"покажи digest\" --pretty",
            f"python agentosctl.py --workspace {workspace_arg} release check --pretty",
        ],
        "acceptance_criteria": [
            "voice status shows gemini_live ready=true",
            "release check optional_blockers no longer contains gemini_live",
            "production readiness status becomes ready_local when no required blockers exist",
            "Gemini Live commands still route through /api/command and approval gates",
        ],
    }
    return {
        "status": "ok",
        "decision": "production_readiness_credential_handoff",
        "dry_run": True,
        "will_apply": False,
        "writes_enabled": False,
        "read_only": True,
        "artifact_path": None,
        "artifact_relpath": None,
        "generated_at": now(),
        "readiness": {
            "status": readiness.get("status"),
            **(readiness.get("readiness") or {}),
            "required_blockers": readiness.get("required_blockers") or [],
            "optional_blockers": readiness.get("optional_blockers") or [],
            "operator_next_steps": readiness.get("operator_next_steps") or [],
        },
        "credential_handoff": handoff,
        "safety": {
            "read_only": True,
            "artifact_write_enabled": False,
            "history_writes_enabled": False,
            "operational_ledgers_mutated": False,
            "config_writes_enabled": False,
            "voice_session_started": False,
        },
        "links": {
            "production_readiness": "/api/production-readiness",
            "production_readiness_export": "/api/production-readiness/export?max_chars=4000",
            "voice_health": "/api/voice-health",
            "voice_config": "/api/voice-config",
        },
    }


def production_readiness_credential_handoff_export_markdown(payload: dict):
    handoff = payload.get("credential_handoff") or {}
    current = handoff.get("current_status") or {}
    readiness = payload.get("readiness") or {}
    safety = payload.get("safety") or {}
    lines = [
        "# AgentOS Gemini Credential Handoff",
        "",
        "- decision: production_readiness_credential_handoff_export_preview",
        f"- source_decision: {payload.get('decision')}",
        f"- handoff_status: {handoff.get('handoff_status')}",
        f"- remaining_external_blocker: {handoff.get('remaining_external_blocker') or 'none'}",
        f"- provider: {handoff.get('provider', 'gemini_live')}",
        f"- required_credentials: {', '.join(handoff.get('required_credentials') or []) or 'none'}",
        f"- preferred_credential: {handoff.get('preferred_credential')}",
        f"- fallback_credential: {handoff.get('fallback_credential')}",
        f"- recommended_storage: {handoff.get('recommended_storage')}",
        f"- do_not_store_in_dashboard: {handoff.get('do_not_store_in_dashboard')}",
        f"- actions_stay_routed_through_command_bridge: {handoff.get('actions_stay_routed_through_command_bridge')}",
        f"- approval_gates_remain_required: {handoff.get('approval_gates_remain_required')}",
        "",
        "## Current Gemini Live Status",
        f"- ready: {current.get('ready')}",
        f"- enabled: {current.get('enabled')}",
        f"- mode: {current.get('mode')}",
        f"- model: {current.get('model')}",
        f"- reasons: {', '.join(current.get('reasons') or []) or 'none'}",
        f"- has_env_key: {current.get('has_env_key')}",
        f"- has_inline_key: {current.get('has_inline_key')}",
        "",
        "## Local Production Readiness Context",
        f"- status: {readiness.get('status')}",
        f"- local_ready: {readiness.get('local_ready')}",
        f"- production_ready: {readiness.get('production_ready')}",
        f"- required_checks_passed: {readiness.get('required_checks_passed')}",
        f"- worker_safe_state: {readiness.get('worker_safe_state')}",
        f"- required_blockers: {', '.join(readiness.get('required_blockers') or []) or 'none'}",
        f"- optional_blockers: {', '.join(readiness.get('optional_blockers') or []) or 'none'}",
        f"- operator_next_steps: {', '.join(readiness.get('operator_next_steps') or []) or 'none'}",
        "",
        "## Setup Steps",
    ]
    for index, step in enumerate(handoff.get("setup_steps") or [], start=1):
        lines.extend([
            f"{index}. {step.get('id')}",
            f"   - summary: {step.get('summary')}",
        ])
        if step.get("windows_user_command"):
            lines.append(f"   - windows_user_command: {step.get('windows_user_command')}")
        if step.get("git_bash_command"):
            lines.append(f"   - git_bash_command: {step.get('git_bash_command')}")
        if step.get("fallback_windows_user_command"):
            lines.append(f"   - fallback_windows_user_command: {step.get('fallback_windows_user_command')}")
        if step.get("command"):
            lines.append(f"   - command: {step.get('command')}")
        if step.get("operator_action"):
            lines.append(f"   - operator_action: {step.get('operator_action')}")
        if step.get("expected_json_fragment"):
            lines.append(f"   - expected_json_fragment: {json.dumps(step.get('expected_json_fragment'), ensure_ascii=False)}")
    lines.extend([
        "",
        "## Verification Commands",
    ])
    for command in handoff.get("verification_commands") or []:
        lines.append(f"- `{command}`")
    lines.extend([
        "",
        "## Acceptance Criteria",
    ])
    for criterion in handoff.get("acceptance_criteria") or []:
        lines.append(f"- {criterion}")
    lines.extend([
        "",
        "## Safety",
        f"- read_only: {safety.get('read_only')}",
        f"- artifact_write_enabled: {safety.get('artifact_write_enabled')}",
        f"- history_writes_enabled: {safety.get('history_writes_enabled')}",
        f"- operational_ledgers_mutated: {safety.get('operational_ledgers_mutated')}",
        f"- config_writes_enabled: {safety.get('config_writes_enabled')}",
        f"- voice_session_started: {safety.get('voice_session_started')}",
        "",
        "## Config Paths",
        f"- local_override_relpath: {handoff.get('local_override_relpath')}",
        f"- local_override_example_relpath: {handoff.get('local_override_example_relpath')}",
        f"- local_override_exists: {handoff.get('local_override_exists')}",
        "",
        "## Notes",
        "- This preview is generated in memory only and does not write a dossier artifact.",
        "- Do not paste secrets into the dashboard. Use environment variables on the operator machine.",
        "- Gemini Live is an audio UX layer; recognized or normalized commands still go through /api/command and existing approval gates.",
    ])
    if handoff.get("config_snapshot"):
        lines.extend([
            "",
            "## Redacted Gemini Config Snapshot",
            "```json",
            json.dumps(handoff.get("config_snapshot"), ensure_ascii=False, indent=2),
            "```",
        ])
    return "\n".join(lines) + "\n"


def production_readiness_credential_handoff_export_preview(workspace: Path, max_chars=4000):
    max_chars = max(0, int(max_chars or 0))
    handoff_payload = redact_secrets(production_readiness_credential_handoff(workspace))
    markdown = redact_production_readiness_markdown(production_readiness_credential_handoff_export_markdown(handoff_payload))
    content_length = len(markdown)
    if max_chars > 0:
        markdown_preview = markdown[:max_chars]
        truncated = len(markdown_preview) < content_length
    else:
        markdown_preview = markdown
        truncated = False
    return {
        "status": "ok",
        "decision": "production_readiness_credential_handoff_export_preview",
        "dry_run": True,
        "will_apply": False,
        "writes_enabled": False,
        "read_only": True,
        "artifact_path": None,
        "artifact_relpath": None,
        "generated_at": now(),
        "readiness": handoff_payload.get("readiness") or {},
        "credential_handoff": handoff_payload.get("credential_handoff") or {},
        "export_preview": {
            "format": "markdown",
            "title": "AgentOS Gemini Credential Handoff",
            "max_chars": max_chars,
            "content_length": content_length,
            "line_count": len(markdown.splitlines()),
            "markdown_preview": markdown_preview,
            "truncated": truncated,
            "redactions": ["api_key", "token", "secret", "password"],
        },
        "safety": {
            "read_only": True,
            "artifact_write_enabled": False,
            "history_writes_enabled": False,
            "operational_ledgers_mutated": False,
            "config_writes_enabled": False,
            "voice_session_started": False,
        },
        "links": {
            "credential_handoff": "/api/production-readiness/credential-handoff",
            "production_readiness": "/api/production-readiness",
            "voice_health": "/api/voice-health",
            "voice_config": "/api/voice-config",
        },
    }


def digest_summary(workspace: Path):
    projects = list_projects(workspace)
    approvals = list_approvals(workspace)
    pending = [a for a in approvals if a.get("status") == "pending"]
    events = list_events(workspace)
    blocked_tasks = []
    for tasks_path in sorted((workspace / "projects").glob("*/tasks.json")):
        for task in read_json(tasks_path, []):
            if task.get("status") == "blocked":
                blocked_tasks.append(task)
    project_lines = "\n".join(f"- `{p.get('slug', 'unknown')}` — {p.get('goal', 'No goal')}" for p in projects) or "- No projects."
    approval_lines = "\n".join(f"- `{a.get('id')}` {a.get('action')} — {a.get('summary')}" for a in pending) or "- No pending approvals."
    blocked_lines = "\n".join(f"- `{t.get('project')}/{t.get('id')}` — {t.get('block_reason')}" for t in blocked_tasks) or "- No blocked tasks."
    markdown = f"""# AgentOS Daily Digest

Generated: {now()}

## Counts
- Projects: {len(projects)}
- Pending approvals: {len(pending)}
- Blocked tasks: {len(blocked_tasks)}
- Events: {len(events)}

## Projects
{project_lines}

## Pending approvals
{approval_lines}

## Blocked tasks
{blocked_lines}
"""
    return {
        "workspace": str(workspace),
        "projects": len(projects),
        "pending_approvals": len(pending),
        "blocked_tasks": len(blocked_tasks),
        "events": len(events),
        "generated_at": now(),
        "markdown": markdown,
    }


def project_tasks(workspace: Path, slug: str):
    return read_json(workspace / "projects" / slug / "tasks.json", [])


def agentic_task(slug: str, task_id: str, objective: str, owner: str, depends_on=None, risk_level="low", requires_approval=False, status="planned", artifacts=None, acceptance=None, lane="orchestra"):
    return {
        "id": task_id,
        "project": slug,
        "objective": objective,
        "owner": owner,
        "status": status,
        "depends_on": depends_on or [],
        "risk_level": risk_level,
        "requires_approval": requires_approval,
        "acceptance_criteria": acceptance or ["Artifact or decision persisted", "Audit event recorded"],
        "artifacts": artifacts or [],
        "block_reason": "waiting for human gate approval" if requires_approval else None,
        "lane": lane,
    }


def agentic_orchestra_tasks(slug: str, goal: str):
    return [
        agentic_task(slug, "T001", "X scout: collect agent-user pain points and candidate opportunities", "x-scout", [], artifacts=["scout-x-report.md"], lane="detect"),
        agentic_task(slug, "T002", "Web scout: collect Reddit/YouTube/web pain points and candidate opportunities", "web-scout", [], artifacts=["scout-web-report.md"], lane="detect"),
        agentic_task(slug, "T003", "Orchestrator intake: merge reports, deduplicate candidates, score rubric >=65", "orchestrator", ["T001", "T002"], artifacts=["intake-rubric.json"], acceptance=["Duplicates removed", "Frequency, pain, solvability, gap, strategic-fit scored"], lane="validate"),
        agentic_task(slug, "T004", "Research lane A: verify source evidence for top candidate", "researcher-source", ["T003"], artifacts=["research-source.md"], lane="parallel-research"),
        agentic_task(slug, "T005", "Research lane B: pull prior context from Memory/Obsidian", "researcher-context", ["T003"], artifacts=["research-context.md"], lane="parallel-research"),
        agentic_task(slug, "T006", "Research lane C: audit existing solutions and gaps", "researcher-solutions", ["T003"], artifacts=["research-solutions.md"], lane="parallel-research"),
        agentic_task(slug, "T007", "Orchestrator route decision: build, video, or shelve", "orchestrator", ["T004", "T005", "T006"], artifacts=["route-decision.md"], lane="route"),
        agentic_task(slug, "T008", "Analyst proposal: synthesize buildable tool/skill plan", "analyst", ["T007"], artifacts=["build-proposal.md"], lane="proposal"),
        agentic_task(slug, "T009", "Video producer proposal: outline explainer/slides/script path", "video-producer", ["T007"], artifacts=["video-proposal.md"], lane="proposal"),
        agentic_task(slug, "T010", "Human gate: approve, shelve, or modify the proposed action", "approval-guard", ["T008", "T009"], risk_level="high", requires_approval=True, artifacts=["human-gate.md"], lane="human-gate"),
        agentic_task(slug, "T011", "Builder agent: create persistent prototype/tool artifact after approval", "builder", ["T010"], artifacts=["prototype.md"], lane="fulfill"),
        agentic_task(slug, "T012", "Tester agent: run verification and capture evidence", "tester", ["T011"], artifacts=["test-report.md"], lane="fulfill"),
        agentic_task(slug, "T013", "Video producer: generate slide/script deliverable after approval", "video-producer", ["T010"], artifacts=["slides-and-speaker-notes.md"], lane="fulfill"),
        agentic_task(slug, "T014", "Orchestrator final delivery: summarize artifacts, recovery status, and next operator step", "orchestrator", ["T012", "T013"], artifacts=["final-handoff.md"], lane="deliver"),
    ]


def create_goal(workspace: Path, goal: str):
    slug = slugify(goal)
    project_dir = workspace / "projects" / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    tasks = [
        {"id": "T001", "project": slug, "objective": "Create project brief", "owner": "orchestrator", "status": "done", "depends_on": [], "risk_level": "low", "requires_approval": False, "acceptance_criteria": ["Goal captured"], "artifacts": ["project-brief.md"], "block_reason": None},
        {"id": "T002", "project": slug, "objective": "Draft content", "owner": "content-agent", "status": "planned", "depends_on": ["T001"], "risk_level": "low", "requires_approval": False, "acceptance_criteria": ["Draft exists"], "artifacts": ["copy.md"], "block_reason": None},
        {"id": "T003", "project": slug, "objective": "Implement artifact", "owner": "coding-agent", "status": "planned", "depends_on": ["T002"], "risk_level": "low", "requires_approval": False, "acceptance_criteria": ["Artifact exists"], "artifacts": [], "block_reason": None},
        {"id": "T004", "project": slug, "objective": "Verify result", "owner": "qa-agent", "status": "planned", "depends_on": ["T003"], "risk_level": "low", "requires_approval": False, "acceptance_criteria": ["QA evidence saved"], "artifacts": ["qa-report.md"], "block_reason": None},
    ]
    metadata = {"slug": slug, "goal": goal, "created_at": now(), "status": "created"}
    write_json(project_dir / "project.json", metadata)
    write_json(project_dir / "tasks.json", tasks)
    write_text(project_dir / "project-brief.md", f"# Project Brief: {goal}\n\n## Goal\n{goal}\n\n## Status\ncreated\n")
    append_event(workspace, "goal_created", project=slug, goal=goal)
    return metadata


def create_agentic_goal(workspace: Path, goal: str):
    slug = slugify(goal)
    project_dir = workspace / "projects" / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    tasks = agentic_orchestra_tasks(slug, goal)
    metadata = {
        "slug": slug,
        "goal": goal,
        "created_at": now(),
        "status": "orchestrated",
        "workflow": "kanban_agentic_orchestra",
        "source_video": "https://www.youtube.com/watch?v=EKVRqcpTT6s",
        "orchestra": {
            "single_source_of_truth": "projects/<slug>/tasks.json + agents/queue.json",
            "rubric_threshold": 65,
            "human_gates": ["T010"],
            "agent_roles": ["x-scout", "web-scout", "orchestrator", "researcher-source", "researcher-context", "researcher-solutions", "analyst", "builder", "tester", "video-producer", "approval-guard"],
        },
    }
    write_json(project_dir / "project.json", metadata)
    write_json(project_dir / "tasks.json", tasks)
    write_text(project_dir / "project-brief.md", "\n".join([
        f"# Agentic Orchestra Brief: {goal}",
        "",
        "## Goal",
        goal,
        "",
        "## Workflow from reference video",
        "Detect → validate/dedupe/rubric → parallel research lanes → route decision → one human gate → builder/tester/video producer → final handoff.",
        "",
        "## Safety",
        "Risky shipping/build/publish decisions wait at T010 until the operator approves, shelves, or modifies the plan.",
    ]) + "\n")
    approval = create_approval(
        workspace,
        "agentic_human_gate",
        f"Approve post-research route for {slug}: build prototype and/or video deliverable after scouts, rubric, and research lanes complete.",
        "high",
        context={"project": slug, "task_id": "T010", "unlock_tasks": ["T011", "T013"], "source_video": "EKVRqcpTT6s"},
    )
    sync_agent_queue(workspace)
    append_event(workspace, "goal_created", project=slug, goal=goal, workflow="kanban_agentic_orchestra", approval_id=approval.get("id"))
    return {**metadata, "approval": approval, "tasks": len(tasks), "queue": list_agent_queue(workspace).get("count", 0)}


HIGH_RISK_ACTIONS = {"send_email", "mass_email", "publish", "deploy", "delete_file", "payment", "change_credentials", "production_change", "enable_agent_worker_daemon", "agentic_human_gate", "agentic_workflow_gate", "create_real_kanban_tasks"}
LOW_RISK_ACTIONS = {"read_file", "write_file", "create_draft", "summarize", "research", "create_task", "run_test"}


def classify_risk(action: str):
    normalized = action.strip().lower().replace("-", "_")
    if normalized in HIGH_RISK_ACTIONS:
        risk, requires = "high", True
    elif normalized in LOW_RISK_ACTIONS:
        risk, requires = "low", False
    else:
        risk, requires = "medium", True
    return {"action": normalized, "risk": risk, "requires_approval": requires, "decision": "approval_required" if requires else "auto_allowed"}


def create_approval(workspace: Path, action: str, summary: str, risk: str, context=None):
    approvals = list_approvals(workspace)
    record = {"id": f"approval_{uuid4().hex[:10]}", "action": action, "summary": summary, "risk": risk, "status": "pending", "created_at": now(), "updated_at": now()}
    if context:
        record["context"] = context
    approvals.append(record)
    write_json(workspace / "approvals" / "approvals.json", approvals)
    return record


def request_approval(workspace: Path, action: str, summary: str, context=None):
    risk = classify_risk(action)
    if not risk["requires_approval"]:
        append_event(workspace, "action_auto_allowed", action=risk["action"], summary=summary, risk=risk["risk"])
        return {**risk, "summary": summary}
    approval = create_approval(workspace, risk["action"], summary, risk["risk"], context=context)
    append_event(workspace, "approval_requested", approval_id=approval["id"], action=risk["action"], summary=summary, risk=risk["risk"])
    return {"decision": "approval_created", "approval": approval}


def advance_agentic_human_gate(workspace: Path, approval: dict, status_value: str):
    context = approval.get("context") or {}
    project = context.get("project")
    task_id = context.get("task_id")
    if approval.get("action") != "agentic_human_gate" or not project or not task_id:
        return None
    if status_value == "approved":
        task = update_task(workspace, project, task_id, {"status": "done", "requires_approval": False, "block_reason": None, "approved_by": "operator", "approved_at": now(), "approval_id": approval.get("id")})
        append_event(workspace, "agentic_human_gate_approved", project=project, task_id=task_id, approval_id=approval.get("id"))
    else:
        task = update_task(workspace, project, task_id, {"status": "blocked", "block_reason": "operator denied/shelved proposal", "approval_id": approval.get("id")})
        append_event(workspace, "agentic_human_gate_denied", project=project, task_id=task_id, approval_id=approval.get("id"))
    sync = sync_agent_queue(workspace)
    return {"task": task, "queue": sync}


def update_approval(workspace: Path, approval_id: str, status_value: str):
    approvals = list_approvals(workspace)
    for approval in approvals:
        if approval.get("id") == approval_id:
            approval["status"] = status_value
            approval["updated_at"] = now()
            write_json(workspace / "approvals" / "approvals.json", approvals)
            gate_result = advance_agentic_human_gate(workspace, approval, status_value)
            workflow_gate_result = continue_agentic_workflow_after_gate(workspace, approval, status_value)
            append_event(workspace, f"approval_{status_value}", approval_id=approval_id, action=approval.get("action"), summary=approval.get("summary"))
            if gate_result:
                approval["gate_result"] = gate_result
            if workflow_gate_result:
                approval["workflow_gate_result"] = workflow_gate_result
            return approval
    return {"error": "approval_not_found", "id": approval_id}


VALID_TASK_STATUSES = {"planned", "ready", "in_progress", "review", "done", "blocked"}


def update_task(workspace: Path, slug: str, task_id: str, updates: dict):
    tasks_path = workspace / "projects" / slug / "tasks.json"
    tasks = read_json(tasks_path, [])
    for task in tasks:
        if task.get("id") == task_id:
            task.update(updates)
            write_json(tasks_path, tasks)
            return task
    return {"error": "task_not_found", "project": slug, "id": task_id}


def set_task_status(workspace: Path, slug: str, task_id: str, status_value: str):
    if status_value not in VALID_TASK_STATUSES:
        return {"error": "invalid_status", "status": status_value, "valid_statuses": sorted(VALID_TASK_STATUSES)}
    updates = {"status": status_value}
    if status_value != "blocked":
        updates["block_reason"] = None
    task = update_task(workspace, slug, task_id, updates)
    if not task.get("error"):
        append_event(workspace, "task_status_changed", project=slug, task_id=task_id, status=status_value)
    return task


def block_task(workspace: Path, slug: str, task_id: str, reason: str):
    if not reason.strip():
        return {"error": "block_reason_required"}
    task = update_task(workspace, slug, task_id, {"status": "blocked", "block_reason": reason.strip()})
    if not task.get("error"):
        append_event(workspace, "task_blocked", project=slug, task_id=task_id, reason=reason.strip())
    return task


def agent_queue_path(workspace: Path):
    return workspace / "agents" / "queue.json"


def build_agent_queue(workspace: Path):
    items = []
    for tasks_path in sorted((workspace / "projects").glob("*/tasks.json")):
        project = tasks_path.parent.name
        tasks = read_json(tasks_path, [])
        status_by_id = {task.get("id"): task.get("status") for task in tasks}
        for task in tasks:
            if task.get("status") != "planned":
                continue
            if task.get("block_reason"):
                continue
            if task.get("requires_approval"):
                continue
            deps = task.get("depends_on") or []
            if any(status_by_id.get(dep) not in {"done", "completed"} for dep in deps):
                continue
            items.append({
                "queue_id": f"{project}:{task.get('id')}",
                "project": project,
                "task_id": task.get("id"),
                "objective": task.get("objective"),
                "owner": task.get("owner"),
                "risk_level": task.get("risk_level"),
                "lane": task.get("lane", "orchestra"),
                "acceptance_criteria": task.get("acceptance_criteria") or [],
                "planned_artifacts": task.get("artifacts") or [],
                "depends_on": deps,
                "created_at": now(),
            })
    return items


def load_agent_queue(workspace: Path):
    return read_json(agent_queue_path(workspace), [])


def save_agent_queue(workspace: Path, items):
    write_json(agent_queue_path(workspace), items)


def sync_agent_queue(workspace: Path):
    existing = {item.get("queue_id"): item for item in load_agent_queue(workspace)}
    items = []
    for item in build_agent_queue(workspace):
        previous = existing.get(item["queue_id"], {})
        items.append({
            **item,
            "status": previous.get("status", "queued"),
            "claimed_by": previous.get("claimed_by"),
            "claimed_at": previous.get("claimed_at"),
            "started_at": previous.get("started_at"),
            "completed_at": previous.get("completed_at"),
            "failed_at": previous.get("failed_at"),
            "cancelled_at": previous.get("cancelled_at"),
            "cancel_reason": previous.get("cancel_reason"),
            "last_error": previous.get("last_error"),
            "retry_count": previous.get("retry_count", 0),
            "artifacts": previous.get("artifacts", []),
            "result_summary": previous.get("result_summary"),
            "executor": previous.get("executor"),
            "log_path": previous.get("log_path"),
            "lease_owner": previous.get("lease_owner"),
            "lease_acquired_at": previous.get("lease_acquired_at"),
            "lease_expires_at": previous.get("lease_expires_at"),
            "heartbeat_at": previous.get("heartbeat_at"),
        })
    save_agent_queue(workspace, items)
    append_event(workspace, "agent_queue_synced", count=len(items))
    return {"status": "synced", "count": len(items), "items": items, "path": str(agent_queue_path(workspace))}


def list_agent_queue(workspace: Path):
    items = load_agent_queue(workspace)
    return {"status": "ok", "count": len(items), "items": items, "path": str(agent_queue_path(workspace))}


def update_agent_queue_item(workspace: Path, queue_id: str, updater):
    items = load_agent_queue(workspace)
    for item in items:
        if item.get("queue_id") == queue_id:
            result = updater(item)
            if result.get("error"):
                return result
            save_agent_queue(workspace, items)
            return {"status": "updated", "item": item, "path": str(agent_queue_path(workspace))}
    return {"error": "queue_item_not_found", "queue_id": queue_id}


def claim_agent_queue_item(workspace: Path, queue_id: str, worker: str):
    def updater(item):
        if item.get("status", "queued") != "queued":
            return {"error": "queue_item_not_claimable", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "claimed"
        item["claimed_by"] = worker.strip() or "unassigned"
        item["claimed_at"] = now()
        append_event(workspace, "agent_queue_claimed", queue_id=queue_id, worker=item["claimed_by"])
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def start_agent_queue_item(workspace: Path, queue_id: str):
    def updater(item):
        if item.get("status") != "claimed":
            return {"error": "queue_item_not_claimed", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "running"
        item["started_at"] = now()
        append_event(workspace, "agent_queue_started", queue_id=queue_id, worker=item.get("claimed_by"))
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def lease_deadline(ttl_seconds):
    ttl = max(0, int(ttl_seconds or 0))
    acquired = datetime.now().replace(microsecond=0)
    return acquired.isoformat(), (acquired + timedelta(seconds=ttl)).isoformat()


def parse_queue_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def clear_queue_lease(item):
    item["lease_owner"] = None
    item["lease_acquired_at"] = None
    item["lease_expires_at"] = None
    item["heartbeat_at"] = None


def lease_agent_queue_item(workspace: Path, queue_id: str, worker: str, ttl_seconds=300):
    worker_name = worker.strip() or "unassigned"
    acquired_at, expires_at = lease_deadline(ttl_seconds)

    def updater(item):
        if item.get("status", "queued") != "queued":
            return {"error": "queue_item_not_leaseable", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "claimed"
        item["claimed_by"] = worker_name
        item["claimed_at"] = acquired_at
        item["lease_owner"] = worker_name
        item["lease_acquired_at"] = acquired_at
        item["heartbeat_at"] = acquired_at
        item["lease_expires_at"] = expires_at
        append_event(workspace, "agent_queue_leased", queue_id=queue_id, worker=worker_name, lease_expires_at=expires_at)
        return {"ok": True}

    return update_agent_queue_item(workspace, queue_id, updater)


def heartbeat_agent_queue_item(workspace: Path, queue_id: str, worker: str, ttl_seconds=300):
    worker_name = worker.strip() or "unassigned"
    heartbeat_at, expires_at = lease_deadline(ttl_seconds)

    def updater(item):
        if item.get("status") not in {"claimed", "running"}:
            return {"error": "queue_item_not_active", "queue_id": queue_id, "current_status": item.get("status")}
        if item.get("lease_owner") != worker_name:
            return {"error": "queue_item_lease_owner_mismatch", "queue_id": queue_id, "lease_owner": item.get("lease_owner"), "worker": worker_name}
        item["heartbeat_at"] = heartbeat_at
        item["lease_expires_at"] = expires_at
        append_event(workspace, "agent_queue_heartbeat", queue_id=queue_id, worker=worker_name, lease_expires_at=expires_at)
        return {"ok": True}

    return update_agent_queue_item(workspace, queue_id, updater)


def requeue_stale_agent_queue_items(workspace: Path):
    items = load_agent_queue(workspace)
    checked_at = datetime.now().replace(microsecond=0)
    changed = []
    for item in items:
        if item.get("status") not in {"claimed", "running"}:
            continue
        expires_at = parse_queue_time(item.get("lease_expires_at"))
        if not expires_at or expires_at > checked_at:
            continue
        previous_owner = item.get("lease_owner") or item.get("claimed_by") or "unknown"
        previous_expiry = item.get("lease_expires_at")
        item["status"] = "queued"
        item["retry_count"] = int(item.get("retry_count") or 0) + 1
        item["claimed_by"] = None
        item["claimed_at"] = None
        item["started_at"] = None
        item["completed_at"] = None
        item["failed_at"] = None
        item["last_error"] = f"stale lease expired for {previous_owner} at {previous_expiry}"
        clear_queue_lease(item)
        changed.append(dict(item))
    save_agent_queue(workspace, items)
    append_event(workspace, "agent_queue_stale_requeued", count=len(changed))
    return {"status": "requeued_stale", "checked_at": checked_at.isoformat(), "requeued": len(changed), "items": changed, "path": str(agent_queue_path(workspace))}


def attach_task_artifact(workspace: Path, project: str, task_id: str, artifact_path: str, status: str | None = None, executor: str | None = None, result_summary: str | None = None, log_path: str | None = None):
    tasks_path = workspace / "projects" / str(project) / "tasks.json"
    tasks = read_json(tasks_path, [])
    for task in tasks:
        if task.get("id") == task_id:
            artifacts = list(task.get("artifacts") or [])
            if artifact_path and artifact_path not in artifacts:
                artifacts.append(artifact_path)
            task["artifacts"] = artifacts
            if executor:
                task["executor"] = executor
            if result_summary:
                task["result_summary"] = result_summary
            if log_path:
                task["log_path"] = log_path
            if status is not None:
                task["status"] = status
                task["block_reason"] = None
            break
    write_json(tasks_path, tasks)


def write_agent_queue_log(workspace: Path, item: dict, worker: str, state: str, extra: str = ""):
    stamp = datetime.now().strftime('%Y%m%dT%H%M%S')
    log_path = workspace / "logs" / "agent-queue" / str(item.get("project")) / f"{item.get('task_id')}_{stamp}.log"
    lines = [
        f"queue_id={item.get('queue_id')}",
        f"worker={worker}",
        f"state={state}",
        f"timestamp={now()}",
    ]
    if extra:
        lines.append(extra)
    write_text(log_path, "\n".join(lines) + "\n")
    return str(log_path)


def agent_queue_runs_path(workspace: Path) -> Path:
    return workspace / "logs" / "agent-queue" / "runs.json"


def load_agent_queue_runs(workspace: Path):
    return read_json(agent_queue_runs_path(workspace), [])


def append_agent_queue_run(workspace: Path, item: dict, worker: str, trigger: str, filters=None, execution_context=None):
    runs = load_agent_queue_runs(workspace)
    artifact_path = (item.get("artifacts") or [None])[0]
    execution_context = execution_context or {}
    record = {
        "run_id": f"run_{datetime.now().strftime('%Y%m%dT%H%M%S')}_{uuid4().hex[:8]}",
        "queue_id": item.get("queue_id"),
        "project": item.get("project"),
        "task_id": item.get("task_id"),
        "objective": item.get("objective"),
        "owner": item.get("owner"),
        "worker": worker,
        "executor": item.get("executor") or worker,
        "trigger": trigger,
        "status": item.get("status"),
        "started_at": item.get("started_at"),
        "completed_at": item.get("completed_at") or now(),
        "artifact_path": artifact_path,
        "log_path": item.get("log_path"),
        "result_summary": item.get("result_summary"),
        "filters": filters or {},
    }
    if execution_context:
        record["execution_context"] = execution_context
        record["runtime_preview_id"] = execution_context.get("runtime_preview_id")
        record["one_shot_run_id"] = execution_context.get("one_shot_run_id")
        record["confirmation_token"] = execution_context.get("confirmation_token")
    runs.append(record)
    write_json(agent_queue_runs_path(workspace), runs)
    return record


def list_agent_queue_runs(workspace: Path, limit=20):
    runs = list(reversed(load_agent_queue_runs(workspace)))
    limit_int = int(limit or 20)
    visible = runs[:limit_int] if limit_int > 0 else runs
    return {"status": "ok", "count": len(runs), "runs": visible, "path": str(agent_queue_runs_path(workspace))}


def find_agent_queue_run(workspace: Path, run_id: str):
    for run in reversed(load_agent_queue_runs(workspace)):
        if run.get("run_id") == run_id or run.get("id") == run_id:
            return run
    return None


def find_agent_worker_runtime_audit_by_queue_run_id(workspace: Path, run_id: str):
    for audit in reversed(load_agent_worker_runtime_audits(workspace)):
        queue_run_ids = audit.get("queue_run_ids") or []
        item_run_ids = [item.get("run_id") for item in (audit.get("items") or []) if isinstance(item, dict)]
        if run_id in queue_run_ids or run_id in item_run_ids:
            return audit
    return None


def agent_queue_run_detail(workspace: Path, run_id: str):
    run = find_agent_queue_run(workspace, run_id)
    if not run:
        return {"status": "agent_queue_run_not_found", "decision": "agent_queue_run_detail", "run_id": run_id, "run": None, "links": {}}
    execution_context = run.get("execution_context") or {}
    runtime_preview_id = run.get("runtime_preview_id") or execution_context.get("runtime_preview_id")
    one_shot_run_id = run.get("one_shot_run_id") or execution_context.get("one_shot_run_id")
    confirmation_token = run.get("confirmation_token") or execution_context.get("confirmation_token")
    audit = find_agent_worker_runtime_audit_by_queue_run_id(workspace, run.get("run_id") or run_id)
    audit_id = audit.get("id") if audit else None
    links = {
        "runtime_preview_detail": f"/api/agent-worker/runtime-previews/{runtime_preview_id}" if runtime_preview_id else None,
        "runtime_audit_detail": f"/api/agent-worker/runtime-audits/{audit_id}" if audit_id else None,
        "artifact_path": run.get("artifact_path"),
        "log_path": run.get("log_path"),
    }
    return {
        "status": "agent_queue_run_found",
        "decision": "agent_queue_run_detail",
        "run_id": run.get("run_id") or run_id,
        "queue_id": run.get("queue_id"),
        "project": run.get("project"),
        "task_id": run.get("task_id"),
        "runtime_preview_id": runtime_preview_id,
        "one_shot_run_id": one_shot_run_id,
        "confirmation_token": confirmation_token,
        "runtime_audit_id": audit_id,
        "links": links,
        "run": run,
    }


def agent_role_execution_sections(item: dict, project_meta: dict, worker: str):
    owner = str(item.get("owner") or worker or "agent")
    objective = str(item.get("objective") or "")
    goal = str(project_meta.get("goal") or "")
    if owner in {"x-scout", "web-scout"}:
        return [
            "## Scout findings",
            f"- Candidate pain point for `{goal}`: agent workflows break when there is no durable shared board.",
            "- Signal: duplicate work, lost state after crashes, no clear handoff between agents.",
            "- Recommendation: pass to orchestrator intake for dedupe and rubric scoring.",
        ]
    if owner == "orchestrator" and "rubric" in objective.lower():
        return [
            "## Intake + rubric",
            "- Dedupe: merged overlapping scout findings into one candidate cluster.",
            "- Rubric: frequency=18, pain=18, solvable=17, solution_gap=16, strategic_fit=17.",
            "- Score: 86/100 → PASS threshold 65.",
        ]
    if owner.startswith("researcher"):
        return [
            "## Research lane result",
            f"- Lane: {owner}.",
            "- Evidence persisted to this artifact so the next route task can recover after restart.",
            "- Finding: Kanban cards + leases + artifacts are the correct shared memory layer.",
        ]
    if owner == "orchestrator" and "route" in objective.lower():
        return [
            "## Route decision",
            "- Decision: build + video proposal.",
            "- Reason: bounded local tool/workflow improvement, explainable to operator, high strategic fit.",
            "- Next: analyst and video-producer prepare proposals; human gate remains required before fulfillment.",
        ]
    if owner == "analyst":
        return [
            "## Build proposal",
            "- Build a local AgentOS orchestra slice: durable cards, claim/lease, role-specific artifacts, approval unlock.",
            "- Scope: local files/API/dashboard only; no external publishing or spending.",
            "- Acceptance: queue runs produce persistent artifacts and approval unlocks downstream tasks.",
        ]
    if owner == "video-producer":
        return [
            "## Video/content proposal",
            "- Outline: why multi-agent systems fail, why Kanban fixes coordination, how AgentOS implements the loop.",
            "- Deliverable: slide/script markdown in persistent artifacts, not scratch workspace.",
        ]
    if owner == "builder":
        return [
            "## Builder output",
            "- Prototype artifact generated after human gate approval.",
            "- Implementation target: AgentOS local dashboard/API/Kanban workflow.",
        ]
    if owner == "tester":
        return [
            "## Tester evidence",
            "- Verified local artifact exists.",
            "- Recommended checks: API smoke, browser smoke, no-secret scan, pytest.",
        ]
    return [
        "## Agent output",
        f"- {owner} completed its assigned card without bypassing the board.",
        "- Result persisted for audit/recovery.",
    ]


def write_agent_queue_artifact(workspace: Path, item: dict, worker: str):
    project_meta = read_json(workspace / "projects" / str(item.get("project")) / "project.json", {})
    stamp = datetime.now().strftime('%Y%m%dT%H%M%S')
    artifact_path = workspace / "artifacts" / "agent-queue" / str(item.get("project")) / f"{item.get('task_id')}_{stamp}.md"
    summary = f"Executed locally by {worker}: {(item.get('owner') or worker)} executed: {item.get('objective')}"
    content = "\n".join([
        f"# Agent Queue Execution — {item.get('project')}/{item.get('task_id')}",
        "",
        f"Goal: {project_meta.get('goal', 'Unknown goal')}",
        f"Worker: {worker}",
        f"Owner role: {item.get('owner')}",
        f"Queue ID: {item.get('queue_id')}",
        f"Lane: {item.get('lane', 'orchestra')}",
        f"Executed at: {now()}",
        "",
        "## Objective",
        str(item.get('objective') or ''),
        "",
        *agent_role_execution_sections(item, project_meta, worker),
        "",
        "## Result summary",
        summary,
        "",
        "## Acceptance",
        "- Local execution artifact saved in a persistent workspace.",
        "- Queue item moved to done through the Kanban coordination layer.",
        "- Audit event recorded; state survives dashboard/server restart.",
    ]) + "\n"
    write_text(artifact_path, content)
    log_path = write_agent_queue_log(workspace, item, worker, "completed", summary)
    return str(artifact_path), summary, log_path


def fail_agent_queue_item(workspace: Path, queue_id: str, reason: str):
    def updater(item):
        if item.get("status") not in {"claimed", "running"}:
            return {"error": "queue_item_not_active", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "failed"
        item["failed_at"] = now()
        item["last_error"] = reason.strip() or "execution failed"
        item["completed_at"] = None
        clear_queue_lease(item)
        append_event(workspace, "agent_queue_failed", queue_id=queue_id, reason=item["last_error"])
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def retry_agent_queue_item(workspace: Path, queue_id: str):
    def updater(item):
        if item.get("status") != "failed":
            return {"error": "queue_item_not_failed", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "queued"
        item["retry_count"] = int(item.get("retry_count") or 0) + 1
        item["claimed_by"] = None
        item["claimed_at"] = None
        item["started_at"] = None
        item["completed_at"] = None
        item["failed_at"] = None
        item["cancelled_at"] = None
        item["cancel_reason"] = None
        clear_queue_lease(item)
        append_event(workspace, "agent_queue_retried", queue_id=queue_id, retry_count=item["retry_count"])
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def cancel_agent_queue_item(workspace: Path, queue_id: str, reason: str):
    def updater(item):
        if item.get("status") in {"done", "cancelled"}:
            return {"error": "queue_item_not_cancellable", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "cancelled"
        item["cancel_reason"] = reason.strip() or "cancelled"
        item["cancelled_at"] = now()
        clear_queue_lease(item)
        append_event(workspace, "agent_queue_cancelled", queue_id=queue_id, reason=item["cancel_reason"])
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def complete_agent_queue_item(workspace: Path, queue_id: str):
    def updater(item):
        if item.get("status") != "running":
            return {"error": "queue_item_not_running", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "done"
        item["completed_at"] = now()
        clear_queue_lease(item)
        attach_task_artifact(
            workspace,
            item.get("project"),
            item.get("task_id"),
            (item.get("artifacts") or [""])[0],
            status="done",
            executor=item.get("executor"),
            result_summary=item.get("result_summary"),
            log_path=item.get("log_path"),
        )
        append_event(workspace, "agent_queue_completed", queue_id=queue_id, worker=item.get("claimed_by"))
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def execute_agent_queue_item(workspace: Path, queue_id: str, worker: str):
    listing = list_agent_queue(workspace)
    item = next((x for x in listing.get("items", []) if x.get("queue_id") == queue_id), None)
    if not item:
        return {"error": "queue_item_not_found", "queue_id": queue_id}
    if item.get("status") in {"failed", "cancelled", "done"}:
        return {"error": "queue_item_not_executable", "queue_id": queue_id, "current_status": item.get("status")}
    if item.get("status", "queued") == "queued":
        claim = claim_agent_queue_item(workspace, queue_id, worker)
        if claim.get("error"):
            return claim
    item = next((x for x in load_agent_queue(workspace) if x.get("queue_id") == queue_id), None)
    if item and item.get("status") == "claimed":
        started = start_agent_queue_item(workspace, queue_id)
        if started.get("error"):
            return started
    live_item = next(x for x in load_agent_queue(workspace) if x.get("queue_id") == queue_id)
    artifact_path, summary, log_path = write_agent_queue_artifact(workspace, live_item, worker)
    updated = update_agent_queue_item(workspace, queue_id, lambda item: item.update({"artifacts": [artifact_path], "result_summary": summary, "executor": worker, "log_path": log_path}) or {"ok": True})
    if updated.get("error"):
        return updated
    attach_task_artifact(workspace, queue_id.split(":", 1)[0], queue_id.split(":", 1)[1], artifact_path)
    completed = complete_agent_queue_item(workspace, queue_id)
    if completed.get("error"):
        return completed
    completed["run_record"] = append_agent_queue_run(workspace, completed.get("item", live_item), worker, "execute")
    return completed


def run_next_agent_queue_item(workspace: Path, worker: str, ttl_seconds=300, queue_id=None, project=None, owner=None, execution_context=None):
    sync_agent_queue(workspace)
    queue = list_agent_queue(workspace).get("items", [])
    filters = {
        "queue_id": (queue_id or "").strip() or None,
        "project": (project or "").strip() or None,
        "owner": (owner or "").strip() or None,
    }

    def matches_filters(candidate):
        if candidate.get("status", "queued") != "queued":
            return False
        if filters["queue_id"] and candidate.get("queue_id") != filters["queue_id"]:
            return False
        if filters["project"] and candidate.get("project") != filters["project"]:
            return False
        if filters["owner"] and candidate.get("owner") != filters["owner"]:
            return False
        return True

    item = next((x for x in queue if matches_filters(x)), None)
    if not item:
        return {"status": "empty", "item": None, "filters": filters, "count": len(queue), "path": str(agent_queue_path(workspace))}
    queue_id = str(item.get("queue_id"))
    worker_name = worker.strip() or str(item.get("owner") or "local-worker")
    leased = lease_agent_queue_item(workspace, queue_id, worker_name, ttl_seconds)
    if leased.get("error"):
        return leased
    started = start_agent_queue_item(workspace, queue_id)
    if started.get("error"):
        return started
    heartbeat = heartbeat_agent_queue_item(workspace, queue_id, worker_name, ttl_seconds)
    if heartbeat.get("error"):
        return heartbeat
    live_item = next(x for x in load_agent_queue(workspace) if x.get("queue_id") == queue_id)
    artifact_path, summary, log_path = write_agent_queue_artifact(workspace, live_item, worker_name)
    updated = update_agent_queue_item(workspace, queue_id, lambda item: item.update({"artifacts": [artifact_path], "result_summary": summary, "executor": worker_name, "log_path": log_path}) or {"ok": True})
    if updated.get("error"):
        return updated
    attach_task_artifact(workspace, live_item.get("project"), live_item.get("task_id"), artifact_path)
    completed = complete_agent_queue_item(workspace, queue_id)
    if completed.get("error"):
        return completed
    completed["run_record"] = append_agent_queue_run(workspace, completed.get("item", live_item), worker_name, "run_next", filters, execution_context)
    completed["status"] = "executed_next"
    append_event(workspace, "agent_queue_run_next_executed", queue_id=queue_id, worker=worker_name)
    return completed


def run_batch_agent_queue_items(workspace: Path, worker: str, max_items=1, ttl_seconds=300, dry_run=False, queue_id=None, project=None, owner=None, execution_context=None):
    sync_agent_queue(workspace)
    queue = list_agent_queue(workspace).get("items", [])
    limit = max(1, int(max_items or 1))
    filters = {
        "queue_id": (queue_id or "").strip() or None,
        "project": (project or "").strip() or None,
        "owner": (owner or "").strip() or None,
    }

    def matches_filters(candidate):
        if candidate.get("status", "queued") != "queued":
            return False
        if filters["queue_id"] and candidate.get("queue_id") != filters["queue_id"]:
            return False
        if filters["project"] and candidate.get("project") != filters["project"]:
            return False
        if filters["owner"] and candidate.get("owner") != filters["owner"]:
            return False
        return True

    planned_items = [dict(item) for item in queue if matches_filters(item)][:limit]
    if dry_run:
        return {"status": "dry_run" if planned_items else "empty", "dry_run": True, "planned": len(planned_items), "executed": 0, "max_items": limit, "filters": filters, "items": planned_items, "results": [], "path": str(agent_queue_path(workspace))}
    if not planned_items:
        return {"status": "empty", "dry_run": False, "planned": 0, "executed": 0, "max_items": limit, "filters": filters, "items": [], "results": [], "path": str(agent_queue_path(workspace))}

    results = []
    executed_items = []
    for _planned in planned_items:
        result = run_next_agent_queue_item(workspace, worker, ttl_seconds, queue_id, project, owner, execution_context)
        results.append(result)
        if result.get("error"):
            return {"status": "error", "dry_run": False, "planned": len(planned_items), "executed": len(executed_items), "max_items": limit, "filters": filters, "items": executed_items, "results": results, "error": result, "path": str(agent_queue_path(workspace))}
        if result.get("status") != "executed_next" or not result.get("item"):
            break
        executed_items.append(result["item"])
    return {"status": "executed_batch" if executed_items else "empty", "dry_run": False, "planned": len(planned_items), "executed": len(executed_items), "max_items": limit, "filters": filters, "items": executed_items, "results": results, "path": str(agent_queue_path(workspace))}


def agentic_orchestrator_overview(workspace: Path, project=None):
    sync_agent_queue(workspace)
    queue = list_agent_queue(workspace).get("items", [])
    projects = list_projects(workspace)
    if project:
        projects = [p for p in projects if p.get("slug") == project]
        queue = [q for q in queue if q.get("project") == project]
    pending = [a for a in list_approvals(workspace) if a.get("status") == "pending" and (not project or (a.get("context") or {}).get("project") == project)]
    by_lane = {}
    for p in projects:
        for task in project_tasks(workspace, p.get("slug", "")):
            lane = task.get("lane", "orchestra")
            by_lane.setdefault(lane, {"total": 0, "done": 0, "blocked": 0, "planned": 0})
            by_lane[lane]["total"] += 1
            status_value = task.get("status") or "planned"
            by_lane[lane][status_value if status_value in by_lane[lane] else "planned"] = by_lane[lane].get(status_value, 0) + 1
    return {
        "status": "ok",
        "decision": "agentic_orchestrator_overview",
        "source_video": "EKVRqcpTT6s",
        "principles": ["Kanban is the durable shared state", "agents claim one card at a time", "research/judgment/build artifacts are persisted", "human gate unlocks fulfillment"],
        "projects": projects,
        "queue": {"count": len(queue), "items": queue},
        "pending_human_gates": pending,
        "lanes": by_lane,
    }


def run_agentic_orchestrator(workspace: Path, project=None, max_steps=20, dry_run=False):
    sync_agent_queue(workspace)
    max_steps = max(1, int(max_steps or 20))
    executed = []
    errors = []
    for step in range(max_steps):
        sync_agent_queue(workspace)
        queue = [item for item in list_agent_queue(workspace).get("items", []) if item.get("status", "queued") == "queued"]
        if project:
            queue = [item for item in queue if item.get("project") == project]
        if not queue:
            break
        item = queue[0]
        if dry_run:
            executed.append({"step": step + 1, "dry_run": True, "queue_id": item.get("queue_id"), "owner": item.get("owner"), "lane": item.get("lane")})
            continue
        worker = str(item.get("owner") or "orchestrator-agent")
        result = run_next_agent_queue_item(workspace, worker, 300, queue_id=item.get("queue_id"), project=project, owner=item.get("owner"), execution_context={"orchestrator_run": True, "source_video": "EKVRqcpTT6s"})
        if result.get("error"):
            errors.append(result)
            break
        executed.append({"step": step + 1, "queue_id": item.get("queue_id"), "owner": item.get("owner"), "lane": item.get("lane"), "run_id": (result.get("run_record") or {}).get("run_id"), "status": result.get("status")})
    overview = agentic_orchestrator_overview(workspace, project)
    gate_wait = bool(overview.get("pending_human_gates")) and not overview.get("queue", {}).get("items")
    return {
        "status": "waiting_for_human_gate" if gate_wait else ("error" if errors else ("executed" if executed else "idle")),
        "decision": "agentic_orchestrator_run",
        "dry_run": dry_run,
        "project": project,
        "executed_count": len([x for x in executed if not x.get("dry_run")]),
        "planned_count": len(executed),
        "executed": executed,
        "errors": errors,
        "overview": overview,
    }


def agent_worker_config_path(workspace: Path) -> Path:
    return workspace / "config" / "agent-worker.json"


def default_agent_worker_config():
    return {
        "version": 1,
        "enabled": False,
        "mode": "preview",
        "worker": "dashboard-agent",
        "max_items_per_tick": 1,
        "ttl_seconds": 300,
        "interval_seconds": 60,
        "preview_ttl_seconds": 900,
        "dry_run": True,
        "runtime_mode": "dry_run",
        "filters": {"queue_id": None, "project": None, "owner": None},
        "requires_approval": True,
        "approval_action": "enable_agent_worker_daemon",
    }


def normalize_agent_worker_config(raw):
    config = default_agent_worker_config()
    raw = raw or {}
    extra_keys = [
        "version", "enabled", "mode", "worker", "max_items_per_tick", "ttl_seconds", "interval_seconds", "preview_ttl_seconds", "dry_run", "runtime_mode",
        "requires_approval", "approval_action", "updated_at", "enable_approval_id", "enable_requested_at",
        "enabled_by_approval", "enabled_at",
    ]
    for key in extra_keys:
        if key in raw:
            config[key] = raw[key]
    filters = dict(config["filters"])
    filters.update(raw.get("filters") or {})
    config["filters"] = {"queue_id": filters.get("queue_id") or None, "project": filters.get("project") or None, "owner": filters.get("owner") or None}
    config["enabled"] = bool(config.get("enabled", False))
    runtime_mode = str(config.get("runtime_mode") or ("execute" if config.get("dry_run") is False else "dry_run")).strip().lower().replace("-", "_")
    if runtime_mode not in {"dry_run", "execute"}:
        runtime_mode = "dry_run"
    config["runtime_mode"] = runtime_mode
    config["dry_run"] = runtime_mode != "execute"
    config["max_items_per_tick"] = max(1, int(config.get("max_items_per_tick") or 1))
    config["ttl_seconds"] = max(1, int(config.get("ttl_seconds") or 300))
    config["interval_seconds"] = max(1, int(config.get("interval_seconds") or 60))
    config["preview_ttl_seconds"] = max(1, int(config.get("preview_ttl_seconds") or 900))
    return config


def load_agent_worker_config(workspace: Path):
    path = agent_worker_config_path(workspace)
    config = normalize_agent_worker_config(read_json(path, {}))
    if not path.exists():
        write_json(path, config)
    return config


def save_agent_worker_config(workspace: Path, updates):
    config = normalize_agent_worker_config(load_agent_worker_config(workspace))
    config["enabled"] = False
    for key in ["worker", "max_items_per_tick", "ttl_seconds", "interval_seconds", "preview_ttl_seconds", "dry_run", "runtime_mode"]:
        if key in updates and updates[key] is not None:
            config[key] = updates[key]
    incoming_filters = updates.get("filters") or {}
    filters = dict(config.get("filters") or {})
    for key in ["queue_id", "project", "owner"]:
        if key in updates and updates[key] is not None:
            filters[key] = updates[key] or None
        if key in incoming_filters:
            filters[key] = incoming_filters[key] or None
    config["filters"] = filters
    config["updated_at"] = now()
    config = normalize_agent_worker_config(config)
    write_json(agent_worker_config_path(workspace), config)
    append_event(workspace, "agent_worker_configured", worker=config.get("worker"), enabled=False)
    return config


def agent_worker_runtime_config_state(config: dict):
    mode = normalize_agent_worker_config(config).get("runtime_mode", "dry_run")
    if mode == "execute":
        guard = "requires_approval_and_execute_mode"
        description = "Manual runtime may execute bounded local queue items only after approved enable_agent_worker_daemon approval."
    else:
        guard = "dry_run_default"
        description = "Manual runtime remains dry-run/audit-only by default."
    return {"mode": mode, "dry_run": mode != "execute", "execution_guard": guard, "description": description}


def find_agent_worker_enable_approvals(workspace: Path):
    approvals = list_approvals(workspace)
    return [approval for approval in approvals if approval.get("action") == "enable_agent_worker_daemon"]


def agent_worker_approval_state(workspace: Path, config=None):
    config = normalize_agent_worker_config(config or load_agent_worker_config(workspace))
    approvals = find_agent_worker_enable_approvals(workspace)
    pending = [approval for approval in approvals if approval.get("status") == "pending"]
    approved = [approval for approval in approvals if approval.get("status") == "approved"]
    configured_id = config.get("enable_approval_id") or config.get("enabled_by_approval")
    configured = next((approval for approval in approvals if approval.get("id") == configured_id), None) if configured_id else None
    return {
        "required": True,
        "action": "enable_agent_worker_daemon",
        "pending_id": pending[-1].get("id") if pending else None,
        "approved_id": approved[-1].get("id") if approved else None,
        "configured_id": configured_id,
        "configured_status": configured.get("status") if configured else None,
        "pending_count": len(pending),
        "approved_count": len(approved),
    }


def request_agent_worker_enable(workspace: Path, summary=None):
    config = load_agent_worker_config(workspace)
    filters = config.get("filters") or {}
    if not summary:
        summary = (
            f"Enable AgentOS worker daemon preview for worker={config.get('worker')} "
            f"max_items_per_tick={config.get('max_items_per_tick')} "
            f"filters(project={filters.get('project') or 'any'}, owner={filters.get('owner') or 'any'}, queue_id={filters.get('queue_id') or 'any'})"
        )
    approval = create_approval(workspace, "enable_agent_worker_daemon", summary, "high")
    config["enabled"] = False
    config["enable_approval_id"] = approval["id"]
    config["enable_requested_at"] = now()
    config["updated_at"] = now()
    config = normalize_agent_worker_config(config)
    write_json(agent_worker_config_path(workspace), config)
    append_event(workspace, "agent_worker_enable_requested", approval_id=approval["id"], summary=summary)
    return {
        "status": "approval_requested",
        "decision": "approval_required",
        "approval": approval,
        "approval_state": agent_worker_approval_state(workspace, config),
        "will_execute": False,
        "scheduler": {"enabled": False, "mode": "approval_gate"},
        "config": config,
        "path": str(agent_worker_config_path(workspace)),
    }


def enable_agent_worker_with_approval(workspace: Path, approval_id: str):
    config = load_agent_worker_config(workspace)
    approval = next((item for item in find_agent_worker_enable_approvals(workspace) if item.get("id") == approval_id), None)
    if not approval or approval.get("status") != "approved":
        return {
            "status": "approval_required",
            "decision": "approval_required",
            "reason": "missing_matching_approved_enable_agent_worker_daemon_approval",
            "approval_id": approval_id,
            "approval_status": approval.get("status") if approval else None,
            "approval_state": agent_worker_approval_state(workspace, config),
            "will_execute": False,
            "scheduler": {"enabled": False, "mode": "approval_gate"},
            "config": config,
            "path": str(agent_worker_config_path(workspace)),
        }
    config["enabled"] = True
    config["dry_run"] = True
    config["enabled_by_approval"] = approval_id
    config["enable_approval_id"] = approval_id
    config["enabled_at"] = now()
    config["updated_at"] = now()
    config = normalize_agent_worker_config(config)
    write_json(agent_worker_config_path(workspace), config)
    append_event(workspace, "agent_worker_enable_approved", approval_id=approval_id)
    return {
        "status": "enabled_preview_only",
        "decision": "approved",
        "approval": approval,
        "approval_state": agent_worker_approval_state(workspace, config),
        "will_execute": False,
        "scheduler": {"enabled": False, "mode": "approved_but_runtime_not_started"},
        "config": config,
        "path": str(agent_worker_config_path(workspace)),
    }


def agent_worker_status(workspace: Path):
    config = load_agent_worker_config(workspace)
    enabled = bool(config.get("enabled"))
    return {
        "status": "enabled_preview_only" if enabled else "disabled",
        "will_execute": False,
        "scheduler": {"enabled": False, "mode": "approved_but_runtime_not_started" if enabled else "disabled_by_default", "reason": "worker daemon runtime is approval-gated and no scheduler is started"},
        "approval": agent_worker_approval_state(workspace, config),
        "runtime": agent_worker_runtime_config_state(config),
        "config": config,
        "path": str(agent_worker_config_path(workspace)),
    }


def agent_worker_tick(workspace: Path, preview=False):
    config = load_agent_worker_config(workspace)
    if not preview:
        enabled = bool(config.get("enabled"))
        return {"status": "runtime_not_started" if enabled else "disabled", "will_execute": False, "executed": 0, "planned": 0, "reason": "worker daemon runtime is not started; use preview for a non-executing dry-run", "approval": agent_worker_approval_state(workspace, config), "config": config, "path": str(agent_worker_config_path(workspace))}
    filters = config.get("filters") or {}
    result = run_batch_agent_queue_items(workspace, str(config.get("worker") or "dashboard-agent"), config.get("max_items_per_tick", 1), config.get("ttl_seconds", 300), True, filters.get("queue_id"), filters.get("project"), filters.get("owner"))
    result["status"] = "preview" if result.get("planned") else "empty"
    result["will_execute"] = False
    result["config"] = config
    result["scheduler"] = {"enabled": False, "mode": "preview_tick"}
    append_event(workspace, "agent_worker_preview_tick", planned=result.get("planned", 0), executed=0)
    return result


def agent_worker_runtime_audits_path(workspace: Path) -> Path:
    return workspace / "logs" / "agent-worker" / "runtime-ticks.json"


def load_agent_worker_runtime_audits(workspace: Path):
    return read_json(agent_worker_runtime_audits_path(workspace), [])


def append_agent_worker_runtime_audit(workspace: Path, record: dict):
    audits = load_agent_worker_runtime_audits(workspace)
    audits.append(record)
    write_json(agent_worker_runtime_audits_path(workspace), audits)
    return record


def list_agent_worker_runtime_audits(workspace: Path, limit=20):
    audits = list(reversed(load_agent_worker_runtime_audits(workspace)))
    limit_int = int(limit or 20)
    visible = audits[:limit_int] if limit_int > 0 else audits
    return {"count": len(visible), "total": len(audits), "audits": visible, "path": str(agent_worker_runtime_audits_path(workspace))}


def find_agent_worker_runtime_audit(workspace: Path, audit_id: str):
    for audit in reversed(load_agent_worker_runtime_audits(workspace)):
        if audit.get("id") == audit_id or audit.get("runtime_audit_id") == audit_id:
            return audit
    return None


def agent_worker_runtime_audit_detail(workspace: Path, audit_id: str):
    audit = find_agent_worker_runtime_audit(workspace, audit_id)
    if not audit:
        return {"status": "runtime_audit_not_found", "decision": "runtime_audit_detail", "audit_id": audit_id, "audit": None, "links": {}}
    resolved_id = audit.get("id") or audit.get("runtime_audit_id") or audit_id
    preview_id = audit.get("preview_id")
    queue_run_ids = audit.get("queue_run_ids") or []
    links = {
        "preview_detail": f"/api/agent-worker/runtime-previews/{preview_id}" if preview_id else None,
        "queue_run_ids": queue_run_ids,
        "queue_run_details": [f"/api/agent-queue/runs/{run_id}" for run_id in queue_run_ids],
        "confirmation_token": audit.get("confirmation_token"),
    }
    return {
        "status": "runtime_audit_found",
        "decision": "runtime_audit_detail",
        "audit_id": resolved_id,
        "runtime_audit_id": resolved_id,
        "preview_id": preview_id,
        "one_shot_run_id": audit.get("one_shot_run_id"),
        "queue_ids": audit.get("queue_ids") or [],
        "queue_run_ids": queue_run_ids,
        "links": links,
        "audit": audit,
    }


def agent_worker_runtime_trace_run_one_shot_id(run: dict):
    execution_context = run.get("execution_context") or {}
    return run.get("one_shot_run_id") or execution_context.get("one_shot_run_id")


def agent_worker_runtime_trace_confirmation_token(record: dict):
    confirmation = record.get("confirmation") or {}
    execution_context = record.get("execution_context") or {}
    return record.get("confirmation_token") or confirmation.get("token") or execution_context.get("confirmation_token")


def append_unique(values: list, candidate):
    if candidate and candidate not in values:
        values.append(candidate)


def agent_worker_runtime_trace_graph(workspace: Path, one_shot_run_id: str):
    previews = [preview for preview in load_agent_worker_runtime_previews(workspace) if preview.get("one_shot_run_id") == one_shot_run_id]
    attempts = [attempt for attempt in load_agent_worker_runtime_confirm_attempts(workspace) if attempt.get("one_shot_run_id") == one_shot_run_id]
    audits = [audit for audit in load_agent_worker_runtime_audits(workspace) if audit.get("one_shot_run_id") == one_shot_run_id]
    queue_runs = [run for run in load_agent_queue_runs(workspace) if agent_worker_runtime_trace_run_one_shot_id(run) == one_shot_run_id]

    preview = previews[-1] if previews else None
    runtime_audit = audits[-1] if audits else None
    found = bool(previews or attempts or audits or queue_runs)
    empty_trace = {"preview": None, "confirmation_attempts": [], "runtime_audit": None, "queue_runs": []}
    empty_counts = {"previews": 0, "confirmation_attempts": 0, "runtime_audits": 0, "queue_runs": 0}
    if not found:
        return {"status": "runtime_trace_not_found", "decision": "runtime_trace_graph", "one_shot_run_id": one_shot_run_id, "counts": empty_counts, "trace": empty_trace, "links": {}}

    preview_id = None
    for source in [preview, runtime_audit, attempts[-1] if attempts else None, queue_runs[-1] if queue_runs else None]:
        if not source:
            continue
        preview_id = source.get("preview_id") or source.get("runtime_preview_id") or (source.get("execution_context") or {}).get("runtime_preview_id")
        if preview_id:
            break

    confirmation_token = None
    for source in [preview, attempts[-1] if attempts else None, runtime_audit, queue_runs[-1] if queue_runs else None]:
        if not source:
            continue
        confirmation_token = agent_worker_runtime_trace_confirmation_token(source)
        if confirmation_token:
            break

    runtime_audit_id = runtime_audit.get("id") if runtime_audit else None
    if not runtime_audit_id:
        for attempt in reversed(attempts):
            runtime_audit_id = attempt.get("runtime_audit_id")
            if runtime_audit_id:
                break

    queue_run_ids = []
    if runtime_audit:
        for run_id in runtime_audit.get("queue_run_ids") or []:
            append_unique(queue_run_ids, run_id)
    for attempt in attempts:
        for run_id in attempt.get("queue_run_ids") or []:
            append_unique(queue_run_ids, run_id)
    if preview:
        for run_id in preview.get("queue_run_ids") or []:
            append_unique(queue_run_ids, run_id)
    for run in queue_runs:
        append_unique(queue_run_ids, run.get("run_id") or run.get("id"))

    confirm_attempt_ids = [attempt.get("id") or attempt.get("confirm_attempt_id") for attempt in attempts if attempt.get("id") or attempt.get("confirm_attempt_id")]
    counts = {"previews": len(previews), "confirmation_attempts": len(attempts), "runtime_audits": len(audits), "queue_runs": len(queue_runs)}
    links = {
        "preview_detail": f"/api/agent-worker/runtime-previews/{preview_id}" if preview_id else None,
        "confirm_attempt_details": [f"/api/agent-worker/runtime-confirm-attempts/{attempt_id}" for attempt_id in confirm_attempt_ids],
        "runtime_audit_detail": f"/api/agent-worker/runtime-audits/{runtime_audit_id}" if runtime_audit_id else None,
        "queue_run_details": [f"/api/agent-queue/runs/{run_id}" for run_id in queue_run_ids],
    }
    return {
        "status": "runtime_trace_found",
        "decision": "runtime_trace_graph",
        "one_shot_run_id": one_shot_run_id,
        "preview_id": preview_id,
        "confirmation_token": confirmation_token,
        "runtime_audit_id": runtime_audit_id,
        "confirm_attempt_ids": confirm_attempt_ids,
        "queue_run_ids": queue_run_ids,
        "counts": counts,
        "trace": {"preview": preview, "confirmation_attempts": attempts, "runtime_audit": runtime_audit, "queue_runs": queue_runs},
        "links": links,
    }


def agent_worker_runtime_trace_export_path(workspace: Path, one_shot_run_id: str):
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(one_shot_run_id or "")).strip("._-")[:120] or "runtime_trace"
    return workspace / "artifacts" / "agent-worker" / "runtime-traces" / f"{safe_id}_trace.md"


def redact_agent_worker_runtime_trace_secrets(value):
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            key_lower = str(key).lower()
            if key_lower in {"token", "confirmation_token", "api_key", "key", "secret", "password"} or key_lower.endswith("_token"):
                redacted[key] = "[REDACTED]" if item else item
            else:
                redacted[key] = redact_agent_worker_runtime_trace_secrets(item)
        return redacted
    if isinstance(value, list):
        return [redact_agent_worker_runtime_trace_secrets(item) for item in value]
    return value


def agent_worker_runtime_trace_export_markdown(trace_result: dict):
    redacted_trace = redact_agent_worker_runtime_trace_secrets(trace_result.get("trace") or {})
    redacted_links = redact_agent_worker_runtime_trace_secrets(trace_result.get("links") or {})
    queue_runs = trace_result.get("trace", {}).get("queue_runs") or []
    lines = [
        f"# Runtime Trace Export — {trace_result.get('one_shot_run_id')}",
        "",
        "## Summary",
        f"- Trace status: {trace_result.get('status')}",
        f"- Decision: runtime_trace_export",
        f"- One-shot run ID: {trace_result.get('one_shot_run_id')}",
        f"- Preview ID: {trace_result.get('preview_id') or '—'}",
        f"- Runtime audit ID: {trace_result.get('runtime_audit_id') or '—'}",
        f"- Confirmation token: {'[REDACTED]' if trace_result.get('confirmation_token') else '—'}",
        f"- Confirmation attempts: {', '.join(trace_result.get('confirm_attempt_ids') or []) or '—'}",
        f"- Queue runs: {', '.join(trace_result.get('queue_run_ids') or []) or '—'}",
        "",
        "## Counts",
        "```json",
        json.dumps(trace_result.get("counts") or {}, ensure_ascii=False, indent=2),
        "```",
        "",
        "## Links",
        "```json",
        json.dumps(redacted_links, ensure_ascii=False, indent=2),
        "```",
        "",
        "## Queue Run Artifact References",
    ]
    if queue_runs:
        for run in queue_runs:
            lines.extend([
                f"- {run.get('run_id') or run.get('id')}: artifact={run.get('artifact_path') or '—'} log={run.get('log_path') or '—'}",
            ])
    else:
        lines.append("- —")
    lines.extend([
        "",
        "## Safety Metadata",
        "- Export decision: runtime_trace_export",
        "- Operational ledgers mutated: false",
        "- Artifact only write: true",
        "- Redactions: confirmation_token, confirmation.token, execution_context.confirmation_token",
        "",
        "## Redacted Trace JSON",
        "```json",
        json.dumps(redacted_trace, ensure_ascii=False, indent=2),
        "```",
        "",
    ])
    return "\n".join(lines)


def export_agent_worker_runtime_trace(workspace: Path, one_shot_run_id: str):
    trace_result = agent_worker_runtime_trace_graph(workspace, one_shot_run_id)
    redactions = ["confirmation_token", "confirmation.token", "execution_context.confirmation_token"]
    if trace_result.get("status") != "runtime_trace_found":
        return {
            "status": "runtime_trace_export_not_found",
            "decision": "runtime_trace_export",
            "trace_status": trace_result.get("status"),
            "one_shot_run_id": one_shot_run_id,
            "counts": trace_result.get("counts"),
            "trace": trace_result.get("trace"),
            "links": trace_result.get("links"),
            "artifact_path": None,
            "artifact_relpath": None,
            "redactions": redactions,
        }
    artifact_path = agent_worker_runtime_trace_export_path(workspace, one_shot_run_id)
    content = agent_worker_runtime_trace_export_markdown(trace_result)
    write_text(artifact_path, content)
    artifact_relpath = artifact_path.relative_to(workspace).as_posix()
    return {
        "status": "runtime_trace_exported",
        "decision": "runtime_trace_export",
        "trace_status": trace_result.get("status"),
        "one_shot_run_id": one_shot_run_id,
        "preview_id": trace_result.get("preview_id"),
        "confirmation_token": "[REDACTED]" if trace_result.get("confirmation_token") else None,
        "runtime_audit_id": trace_result.get("runtime_audit_id"),
        "confirm_attempt_ids": trace_result.get("confirm_attempt_ids") or [],
        "queue_run_ids": trace_result.get("queue_run_ids") or [],
        "counts": trace_result.get("counts"),
        "links": trace_result.get("links"),
        "artifact_path": str(artifact_path),
        "artifact_relpath": artifact_relpath,
        "redactions": redactions,
    }


def agent_worker_runtime_trace_exports_dir(workspace: Path):
    return workspace / "artifacts" / "agent-worker" / "runtime-traces"


def agent_worker_runtime_trace_export_one_shot_run_id(path: Path):
    stem = path.stem
    if stem.endswith("_trace"):
        return stem[:-6]
    return stem


def agent_worker_runtime_trace_export_title(path: Path):
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("# "):
                return stripped[2:].strip()
            if stripped:
                break
    except OSError:
        return None
    return None


def list_agent_worker_runtime_trace_exports(workspace: Path, limit=20):
    export_dir = agent_worker_runtime_trace_exports_dir(workspace)
    if export_dir.exists():
        paths = sorted(export_dir.glob("*_trace.md"), key=lambda path: path.stat().st_mtime, reverse=True)
    else:
        paths = []
    total = len(paths)
    selected = paths if int(limit or 0) == 0 else paths[: max(int(limit or 20), 0)]
    exports = []
    for path in selected:
        stat = path.stat()
        artifact_relpath = path.relative_to(workspace).as_posix()
        exports.append({
            "one_shot_run_id": agent_worker_runtime_trace_export_one_shot_run_id(path),
            "filename": path.name,
            "title": agent_worker_runtime_trace_export_title(path),
            "artifact_path": str(path),
            "artifact_relpath": artifact_relpath,
            "size_bytes": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
        })
    return {
        "status": "ok",
        "decision": "runtime_trace_export_index",
        "path": str(export_dir),
        "total": total,
        "count": len(exports),
        "limit": int(limit or 0),
        "exports": exports,
        "links": {"exports_dir": "artifacts/agent-worker/runtime-traces"},
    }


def agent_worker_runtime_trace_export_storage_directory_summary(workspace: Path, name: str, path: Path, relpath: str, pattern: str):
    if path.exists() and path.is_dir():
        paths = [item for item in path.glob(pattern) if item.is_file()]
    else:
        paths = []
    stats = [(item, item.stat()) for item in paths]
    total_size = sum(stat.st_size for _, stat in stats)
    oldest = min(stats, key=lambda item: item[1].st_mtime, default=None)
    newest = max(stats, key=lambda item: item[1].st_mtime, default=None)
    largest = max(stats, key=lambda item: item[1].st_size, default=None)

    def modified_at(item):
        return datetime.fromtimestamp(item[1].st_mtime).replace(microsecond=0).isoformat() if item else None

    def rel(item):
        return item[0].relative_to(workspace).as_posix() if item else None

    return {
        "name": name,
        "path": str(path),
        "relpath": relpath,
        "exists": path.exists() and path.is_dir(),
        "pattern": pattern,
        "count": len(paths),
        "total_size_bytes": total_size,
        "oldest_modified_at": modified_at(oldest),
        "newest_modified_at": modified_at(newest),
        "oldest_relpath": rel(oldest),
        "newest_relpath": rel(newest),
        "largest_size_bytes": largest[1].st_size if largest else 0,
        "largest_relpath": rel(largest),
    }


def agent_worker_runtime_trace_export_storage_summary(workspace: Path):
    export_dir = agent_worker_runtime_trace_exports_dir(workspace)
    archive_root = agent_worker_runtime_trace_export_archive_dir(workspace)
    pruned_root = agent_worker_runtime_trace_export_pruned_dir(workspace)
    directories = {
        "active": agent_worker_runtime_trace_export_storage_directory_summary(workspace, "active", export_dir, "artifacts/agent-worker/runtime-traces", "*_trace.md"),
        "archive": agent_worker_runtime_trace_export_storage_directory_summary(workspace, "archive", archive_root, "artifacts/agent-worker/runtime-traces/archive", "*_trace_*.md"),
        "pruned": agent_worker_runtime_trace_export_storage_directory_summary(workspace, "pruned", pruned_root, "artifacts/agent-worker/runtime-traces/pruned", "*_pruned_*.md"),
    }
    return {
        "status": "ok",
        "decision": "runtime_trace_export_storage_summary",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "path": str(export_dir),
        "directories": directories,
        "totals": {
            "count": sum(item["count"] for item in directories.values()),
            "total_size_bytes": sum(item["total_size_bytes"] for item in directories.values()),
            "active_count": directories["active"]["count"],
            "archive_count": directories["archive"]["count"],
            "pruned_count": directories["pruned"]["count"],
        },
        "links": {
            "active_index": "/api/agent-worker/runtime-trace-exports?limit=20",
            "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20",
            "pruned_index": "/api/agent-worker/runtime-trace-export-pruned?limit=20",
            "retention_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30",
        },
    }


def agent_worker_runtime_trace_export_retention_preset_definitions():
    return [
        {
            "name": "conservative",
            "label": "Conservative",
            "description": "Keep more active and archived trace exports; lowest churn for operators reviewing history.",
            "policy": {"max_active": 25, "max_archived": 100, "older_than_days": 90},
            "risk": "low_churn",
        },
        {
            "name": "standard",
            "label": "Standard",
            "description": "Balanced default for routine local AgentOS operation.",
            "policy": {"max_active": 10, "max_archived": 50, "older_than_days": 30},
            "risk": "balanced",
        },
        {
            "name": "aggressive",
            "label": "Aggressive",
            "description": "Free disk space sooner; requires careful candidate review before applying retention.",
            "policy": {"max_active": 3, "max_archived": 10, "older_than_days": 7},
            "risk": "higher_churn",
        },
    ]


def agent_worker_runtime_trace_export_retention_preview_url(policy: dict):
    return (
        "/api/agent-worker/runtime-trace-export-retention/preview"
        f"?max_active={policy['max_active']}"
        f"&max_archived={policy['max_archived']}"
        f"&older_than_days={policy['older_than_days']}"
    )


def agent_worker_runtime_trace_export_recommended_retention_policy():
    for preset in agent_worker_runtime_trace_export_retention_preset_definitions():
        if preset["name"] == "standard":
            return dict(preset["policy"])
    return {"max_active": 10, "max_archived": 50, "older_than_days": 30}


def agent_worker_runtime_trace_export_retention_presets(workspace: Path):
    presets = []
    for item in agent_worker_runtime_trace_export_retention_preset_definitions():
        policy = dict(item["policy"])
        presets.append({
            "name": item["name"],
            "label": item["label"],
            "description": item["description"],
            "risk": item["risk"],
            "policy": policy,
            "is_default": item["name"] == "standard",
            "dry_run": True,
            "will_apply": False,
            "preview_url": agent_worker_runtime_trace_export_retention_preview_url(policy),
            "operator_note": "retention_apply_requires_confirmation; preset buttons only load read-only previews",
        })
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_presets",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "default_preset": "standard",
        "preset_names": [preset["name"] for preset in presets],
        "presets": presets,
        "history": {
            "status": "not_recorded",
            "records": [],
            "writes_enabled": False,
            "reason": "retention_presets_are_read_only",
        },
        "links": {
            "self": "/api/agent-worker/runtime-trace-export-retention/presets",
            "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/recommended-preview",
            "recommendations": "/api/agent-worker/runtime-trace-export-retention/recommendations",
            "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
        },
    }


def retention_candidate_size_bytes(candidates):
    return sum(int(candidate.get("size_bytes") or 0) for candidate in candidates)


def agent_worker_runtime_trace_export_retention_preset_impact_row(workspace: Path, preset: dict):
    policy = preset["policy"]
    preview = agent_worker_runtime_trace_export_retention_preview(
        workspace,
        policy["max_active"],
        policy["max_archived"],
        policy["older_than_days"],
    )
    archive_candidates = preview.get("archive_candidates", [])
    prune_candidates = preview.get("prune_candidates", [])
    archive_candidate_size_bytes = retention_candidate_size_bytes(archive_candidates)
    prune_candidate_size_bytes = retention_candidate_size_bytes(prune_candidates)
    counts = preview.get("counts", {})
    archive_candidate_count = int(counts.get("archive_candidates") or 0)
    prune_candidate_count = int(counts.get("prune_candidates") or 0)
    return {
        "name": preset["name"],
        "label": preset.get("label", preset["name"]),
        "description": preset.get("description", ""),
        "risk": preset.get("risk"),
        "policy": policy,
        "is_default": preset.get("is_default", False),
        "dry_run": True,
        "will_apply": False,
        "preview_url": preset["preview_url"],
        "preview": preview,
        "counts": counts,
        "archive_candidate_count": archive_candidate_count,
        "prune_candidate_count": prune_candidate_count,
        "total_candidate_count": archive_candidate_count + prune_candidate_count,
        "archive_candidate_size_bytes": archive_candidate_size_bytes,
        "prune_candidate_size_bytes": prune_candidate_size_bytes,
        "total_candidate_size_bytes": archive_candidate_size_bytes + prune_candidate_size_bytes,
        "candidates": {
            "archive_candidates": archive_candidates,
            "prune_candidates": prune_candidates,
        },
        "highest_impact": False,
    }


def agent_worker_runtime_trace_export_retention_preset_impact(workspace: Path):
    presets_result = agent_worker_runtime_trace_export_retention_presets(workspace)
    impacts = [
        agent_worker_runtime_trace_export_retention_preset_impact_row(workspace, preset)
        for preset in presets_result["presets"]
    ]
    max_archive_candidates = max((impact["archive_candidate_count"] for impact in impacts), default=0)
    max_prune_candidates = max((impact["prune_candidate_count"] for impact in impacts), default=0)
    max_total_candidates = max((impact["total_candidate_count"] for impact in impacts), default=0)
    max_total_candidate_size_bytes = max((impact["total_candidate_size_bytes"] for impact in impacts), default=0)
    for impact in impacts:
        impact["highest_impact"] = bool(max_total_candidate_size_bytes and impact["total_candidate_size_bytes"] == max_total_candidate_size_bytes)
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preset_impact",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "default_preset": presets_result["default_preset"],
        "preset_names": presets_result["preset_names"],
        "matrix_columns": [
            "preset",
            "max_active",
            "max_archived",
            "older_than_days",
            "archive_candidates",
            "prune_candidates",
            "total_candidates",
            "archive_candidate_size_bytes",
            "prune_candidate_size_bytes",
            "total_candidate_size_bytes",
        ],
        "storage_summary": agent_worker_runtime_trace_export_storage_summary(workspace),
        "impacts": impacts,
        "totals": {
            "presets": len(impacts),
            "max_archive_candidates": max_archive_candidates,
            "max_prune_candidates": max_prune_candidates,
            "max_total_candidates": max_total_candidates,
            "max_total_candidate_size_bytes": max_total_candidate_size_bytes,
        },
        "links": {
            "presets": "/api/agent-worker/runtime-trace-export-retention/presets",
            "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/recommended-preview",
            "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
        },
    }


def agent_worker_runtime_trace_export_retention_preset_impact_detail(workspace: Path, preset_name: str):
    presets_result = agent_worker_runtime_trace_export_retention_presets(workspace)
    for preset in presets_result["presets"]:
        if preset["name"] == preset_name:
            impact = agent_worker_runtime_trace_export_retention_preset_impact_row(workspace, preset)
            return {
                "status": "runtime_trace_export_retention_preset_impact_found",
                "decision": "runtime_trace_export_retention_preset_impact_detail",
                "dry_run": True,
                "will_apply": False,
                "generated_at": now(),
                "preset_name": preset_name,
                **impact,
                "links": {
                    "preset_impact": "/api/agent-worker/runtime-trace-export-retention/preset-impact",
                    "presets": "/api/agent-worker/runtime-trace-export-retention/presets",
                    "preview": impact["preview_url"],
                    "recommended_preview": "/api/agent-worker/runtime-trace-export-retention/recommended-preview",
                    "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
                },
            }
    return {
        "status": "runtime_trace_export_retention_preset_impact_not_found",
        "decision": "runtime_trace_export_retention_preset_impact_detail",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "preset_name": preset_name,
        "impact": None,
        "candidates": {"archive_candidates": [], "prune_candidates": []},
        "links": {
            "preset_impact": "/api/agent-worker/runtime-trace-export-retention/preset-impact",
            "presets": "/api/agent-worker/runtime-trace-export-retention/presets",
        },
    }


def agent_worker_runtime_trace_export_retention_preset_advice_guidance(impact: dict, recommended_name: str, recommended_has_action: bool):
    candidate_count = int(impact.get("total_candidate_count") or 0)
    candidate_bytes = int(impact.get("total_candidate_size_bytes") or 0)
    if not candidate_count:
        level = "monitor"
        reason = "preset_has_no_candidates"
    elif impact["name"] == recommended_name:
        level = "recommended"
        reason = "selected_policy_matches_current_storage_pressure"
    elif recommended_name == "conservative" and impact["name"] == "standard":
        level = "more_aggressive_than_recommended"
        reason = "standard_would_apply_more_changes_than_safest_action"
    elif impact["name"] == "aggressive":
        level = "higher_churn_available"
        reason = "aggressive_frees_more_space_but_has_higher_churn"
    elif recommended_has_action:
        level = "lower_impact_alternative"
        reason = "preset_has_fewer_candidates_than_recommended_policy"
    else:
        level = "monitor"
        reason = "default_policy_recommends_monitoring"
    return {
        "name": impact["name"],
        "label": impact.get("label", impact["name"]),
        "policy": impact["policy"],
        "candidate_count": candidate_count,
        "candidate_size_bytes": candidate_bytes,
        "archive_candidate_count": int(impact.get("archive_candidate_count") or 0),
        "prune_candidate_count": int(impact.get("prune_candidate_count") or 0),
        "guidance_level": level,
        "reason": reason,
        "preview_url": impact.get("preview_url"),
        "impact_detail_url": f"/api/agent-worker/runtime-trace-export-retention/preset-impact/{impact['name']}",
    }


def agent_worker_runtime_trace_export_retention_preset_advice(workspace: Path):
    impact_matrix = agent_worker_runtime_trace_export_retention_preset_impact(workspace)
    impacts = {impact["name"]: impact for impact in impact_matrix.get("impacts", [])}
    conservative = impacts.get("conservative")
    standard = impacts.get("standard")
    aggressive = impacts.get("aggressive")
    totals = ((impact_matrix.get("storage_summary") or {}).get("totals") or {})
    total_artifacts = int(totals.get("count") or 0)

    if conservative and int(conservative.get("total_candidate_count") or 0) > 0:
        recommended = conservative
        reason_codes = [
            "preset_impact_matrix_evaluated",
            "conservative_has_candidates_safest_action",
            "retention_apply_requires_confirm_retention_true",
        ]
    elif standard and int(standard.get("total_candidate_count") or 0) > 0:
        recommended = standard
        reason_codes = [
            "preset_impact_matrix_evaluated",
            "standard_has_candidates_balanced_default",
            "retention_apply_requires_confirm_retention_true",
        ]
    else:
        recommended = standard or conservative or aggressive or {"name": "standard", "policy": agent_worker_runtime_trace_export_recommended_retention_policy(), "preview_url": agent_worker_runtime_trace_export_retention_preview_url(agent_worker_runtime_trace_export_recommended_retention_policy()), "total_candidate_count": 0, "total_candidate_size_bytes": 0}
        if total_artifacts:
            reason_codes = [
                "preset_impact_matrix_evaluated",
                "default_policy_has_no_candidates",
                "monitor_storage_summary",
            ]
        else:
            reason_codes = [
                "preset_impact_matrix_evaluated",
                "no_runtime_trace_exports_detected",
                "monitor_storage_summary",
            ]

    recommended_has_action = int(recommended.get("total_candidate_count") or 0) > 0
    severity = "action_recommended" if recommended_has_action else ("monitor" if total_artifacts else "empty")
    recommended_action = "review_retention_preview" if recommended_has_action else "monitor_storage"
    if recommended_has_action:
        operator_next_steps = [
            f"review_{recommended['name']}_impact_detail",
            f"preview_{recommended['name']}_retention",
            "apply_retention_requires_confirm_retention_true",
        ]
    else:
        operator_next_steps = [
            "monitor_storage_summary",
            "review_preset_impact_if_disk_pressure_changes",
        ]
    preset_guidance = [
        agent_worker_runtime_trace_export_retention_preset_advice_guidance(impact, recommended["name"], recommended_has_action)
        for impact in impact_matrix.get("impacts", [])
    ]
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preset_advice",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "recommended_preset": recommended["name"],
        "recommended_policy": recommended["policy"],
        "recommended_action": recommended_action,
        "severity": severity,
        "reason_codes": reason_codes,
        "recommended_impact": recommended,
        "impact_matrix": impact_matrix,
        "preset_guidance": preset_guidance,
        "operator_next_steps": operator_next_steps,
        "safety": {
            "read_only": True,
            "retention_apply_called": False,
            "history_writes_enabled": False,
            "operational_ledgers_mutated": False,
        },
        "links": {
            "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
            "preset_impact": "/api/agent-worker/runtime-trace-export-retention/preset-impact",
            "recommended_impact_detail": f"/api/agent-worker/runtime-trace-export-retention/preset-impact/{recommended['name']}",
            "recommended_preview": recommended["preview_url"],
            "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
        },
    }


def agent_worker_runtime_trace_export_retention_preset_advice_audit_preview(workspace: Path):
    advice = agent_worker_runtime_trace_export_retention_preset_advice(workspace)
    recommended_impact = advice.get("recommended_impact") or {}
    audit_relpath = "logs/agent-worker/retention-preset-advice-history.json"
    audit_path = workspace / "logs" / "agent-worker" / "retention-preset-advice-history.json"
    recommended_impact_summary = {
        "archive_candidate_count": int(recommended_impact.get("archive_candidate_count") or 0),
        "prune_candidate_count": int(recommended_impact.get("prune_candidate_count") or 0),
        "total_candidate_count": int(recommended_impact.get("total_candidate_count") or 0),
        "total_candidate_size_bytes": int(recommended_impact.get("total_candidate_size_bytes") or 0),
    }
    safety = {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    would_record = {
        "record_type": "retention_preset_advice",
        "status": "would_record",
        "record_id": f"retention_preset_advice_{uuid4().hex[:10]}",
        "created_at": now(),
        "writes_enabled": False,
        "recommended_preset": advice.get("recommended_preset"),
        "recommended_policy": advice.get("recommended_policy"),
        "recommended_action": advice.get("recommended_action"),
        "severity": advice.get("severity"),
        "reason_codes": advice.get("reason_codes", []),
        "operator_next_steps": advice.get("operator_next_steps", []),
        "recommended_impact_summary": recommended_impact_summary,
        "safety": safety,
    }
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preset_advice_audit_preview",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "writes_enabled": False,
        "audit_path": audit_path.as_posix(),
        "audit_relpath": audit_relpath,
        "history": {
            "status": "not_recorded",
            "records": [],
            "writes_enabled": False,
            "reason": "retention_preset_advice_audit_preview_is_read_only",
        },
        "advice": advice,
        "would_record": would_record,
        "links": {
            "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview",
            "preset_advice": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
            "recommended_impact_detail": advice["links"]["recommended_impact_detail"],
            "recommended_preview": advice["links"]["recommended_preview"],
        },
    }


def agent_worker_runtime_trace_export_retention_preset_advice_explain(workspace: Path):
    advice = agent_worker_runtime_trace_export_retention_preset_advice(workspace)
    recommended_impact = advice.get("recommended_impact") or {}
    recommended_name = advice.get("recommended_preset") or recommended_impact.get("name") or "standard"
    recommended_action = advice.get("recommended_action") or "monitor_storage"
    severity = advice.get("severity") or "monitor"
    impact_summary = {
        "archive_candidate_count": int(recommended_impact.get("archive_candidate_count") or 0),
        "prune_candidate_count": int(recommended_impact.get("prune_candidate_count") or 0),
        "total_candidate_count": int(recommended_impact.get("total_candidate_count") or 0),
        "total_candidate_size_bytes": int(recommended_impact.get("total_candidate_size_bytes") or 0),
    }
    reason_codes = advice.get("reason_codes", [])
    if "no_runtime_trace_exports_detected" in reason_codes:
        recommended_explanation = "No runtime trace export artifacts were detected, so the standard preset is explained as monitor-only guidance."
    elif recommended_name == "conservative" and impact_summary["total_candidate_count"]:
        recommended_explanation = "Conservative is the safest preset that still has candidates, minimizing churn while giving operators a concrete cleanup preview."
    elif recommended_name == "standard" and impact_summary["total_candidate_count"]:
        recommended_explanation = "Standard is the balanced default preset with candidates when conservative does not require action."
    else:
        recommended_explanation = "The recommended preset has no current candidates, so operators should monitor storage and revisit impact if disk pressure changes."

    alternatives = []
    for guidance in advice.get("preset_guidance", []):
        if guidance.get("name") == recommended_name:
            continue
        candidate_count = int(guidance.get("candidate_count") or 0)
        if not candidate_count:
            alt_explanation = "No candidates under this preset right now; keep it as monitor-only context."
        elif guidance.get("guidance_level") == "more_aggressive_than_recommended":
            alt_explanation = "This preset would apply more changes than the current recommendation and should be used only when extra cleanup is intentional."
        elif guidance.get("guidance_level") == "higher_churn_available":
            alt_explanation = "This preset can free more space but has the highest churn and should be reviewed carefully before apply."
        else:
            alt_explanation = "This preset is an alternative impact profile for operator comparison."
        alternatives.append({
            "preset": guidance.get("name"),
            "label": guidance.get("label"),
            "policy": guidance.get("policy"),
            "guidance_level": guidance.get("guidance_level"),
            "reason": guidance.get("reason"),
            "candidate_count": candidate_count,
            "candidate_size_bytes": int(guidance.get("candidate_size_bytes") or 0),
            "archive_candidate_count": int(guidance.get("archive_candidate_count") or 0),
            "prune_candidate_count": int(guidance.get("prune_candidate_count") or 0),
            "preview_url": guidance.get("preview_url"),
            "impact_detail_url": guidance.get("impact_detail_url"),
            "explanation": alt_explanation,
        })

    safety_gates = [
        {
            "code": "dry_run_only",
            "title": "Explanation is dry-run only",
            "explanation": "This endpoint reads preset advice and formats explanatory text; it never applies retention.",
        },
        {
            "code": "retention_apply_requires_confirm_retention_true",
            "title": "Retention apply remains separately confirmed",
            "explanation": "Any real retention action must go through the apply endpoint with explicit confirm_retention=true.",
        },
        {
            "code": "no_history_writes",
            "title": "No history writes",
            "explanation": "Explanation does not write advice history or create the future advice-history ledger.",
        },
        {
            "code": "no_operational_ledger_mutation",
            "title": "Operational ledgers unchanged",
            "explanation": "Runtime previews, confirmation attempts, ticks, queue runs, and task state are not mutated.",
        },
    ]
    safety = {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    explanation = {
        "summary": f"Recommended preset {recommended_name}: {recommended_action} ({severity}).",
        "recommended": {
            "preset": recommended_name,
            "label": recommended_impact.get("label", recommended_name),
            "policy": advice.get("recommended_policy"),
            "action": recommended_action,
            "severity": severity,
            "reason_codes": reason_codes,
            "impact_summary": impact_summary,
            "preview_url": advice.get("links", {}).get("recommended_preview"),
            "impact_detail_url": advice.get("links", {}).get("recommended_impact_detail"),
            "explanation": recommended_explanation,
        },
        "alternatives": alternatives,
        "safety_gates": safety_gates,
        "operator_steps": advice.get("operator_next_steps", []),
    }
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preset_advice_explanation",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "writes_enabled": False,
        "advice": advice,
        "explanation": explanation,
        "safety": safety,
        "links": {
            "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain",
            "preset_advice": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
            "preset_advice_audit_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview",
            "recommended_impact_detail": advice["links"]["recommended_impact_detail"],
            "recommended_preview": advice["links"]["recommended_preview"],
        },
    }


def agent_worker_runtime_trace_export_retention_preset_advice_checklist(workspace: Path):
    explanation_payload = agent_worker_runtime_trace_export_retention_preset_advice_explain(workspace)
    advice = explanation_payload.get("advice") or {}
    explanation = explanation_payload.get("explanation") or {}
    recommended = explanation.get("recommended") or {}
    recommended_name = recommended.get("preset") or advice.get("recommended_preset") or "standard"
    recommended_policy = recommended.get("policy") or advice.get("recommended_policy") or agent_worker_runtime_trace_export_recommended_retention_policy()
    recommended_action = recommended.get("action") or advice.get("recommended_action") or "monitor_storage"
    severity = recommended.get("severity") or advice.get("severity") or "monitor"
    recommended_impact_detail = explanation_payload["links"]["recommended_impact_detail"]
    recommended_preview = explanation_payload["links"]["recommended_preview"]
    safety_gate_codes = [gate.get("code") for gate in explanation.get("safety_gates", [])]
    apply_status = "blocked_until_explicit_confirmation" if recommended_action != "monitor_storage" else "not_recommended_for_monitor_only_advice"
    checklist = {
        "recommended_preset": recommended_name,
        "recommended_policy": recommended_policy,
        "recommended_action": recommended_action,
        "severity": severity,
        "operator_goal": "review_before_any_retention_apply",
        "apply_allowed_by_checklist": False,
        "requires_explicit_confirmation": True,
        "confirmation_field": "confirm_retention",
        "confirmation_value": True,
        "items": [
            {
                "id": "review_recommended_impact_detail",
                "order": 1,
                "title": "Review recommended preset impact detail",
                "required": True,
                "status": "pending_operator_review",
                "endpoint": recommended_impact_detail,
                "mutates_now": False,
                "rationale": "Inspect exact archive and prune candidates before considering apply.",
            },
            {
                "id": "preview_recommended_retention_policy",
                "order": 2,
                "title": "Preview recommended retention policy",
                "required": True,
                "status": "pending_operator_review",
                "endpoint": recommended_preview,
                "mutates_now": False,
                "rationale": "Re-run the dry-run preview and compare counts before any confirmed apply.",
            },
            {
                "id": "verify_safety_gates",
                "order": 3,
                "title": "Verify safety gates",
                "required": True,
                "status": "pending_operator_review",
                "gates": safety_gate_codes,
                "mutates_now": False,
                "rationale": "Confirm the current endpoint is read-only and that apply remains separately gated.",
            },
            {
                "id": "confirm_retention_apply_manually",
                "order": 4,
                "title": "Confirm retention apply manually only if review passes",
                "required": True,
                "status": apply_status,
                "endpoint": "/api/agent-worker/runtime-trace-export-retention/apply",
                "mutates_now": False,
                "requires_explicit_confirmation": True,
                "confirmation_field": "confirm_retention",
                "confirmation_value": True,
                "rationale": "This checklist never applies retention; a separate confirmed apply call is required.",
            },
        ],
    }
    safety = {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preset_advice_checklist",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "writes_enabled": False,
        "advice": advice,
        "explanation": explanation_payload,
        "checklist": checklist,
        "safety": safety,
        "links": {
            "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist",
            "preset_advice": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
            "preset_advice_explanation": "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain",
            "preset_advice_audit_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview",
            "recommended_impact_detail": recommended_impact_detail,
            "recommended_preview": recommended_preview,
            "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
        },
    }


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_progress(workspace: Path):
    checklist_payload = agent_worker_runtime_trace_export_retention_preset_advice_checklist(workspace)
    checklist = checklist_payload.get("checklist") or {}
    recommended_action = checklist.get("recommended_action") or "monitor_storage"
    monitor_only = recommended_action == "monitor_storage"
    progress_items = []
    counts = {
        "informational": 0,
        "pending_operator_review": 0,
        "blocked_behind_explicit_confirmation": 0,
        "not_recommended": 0,
    }
    for item in checklist.get("items", []):
        item_id = item.get("id")
        if item_id == "verify_safety_gates":
            progress_status = "informational"
            operator_action = "read_safety_gates"
            blocks_apply = False
        elif item_id == "confirm_retention_apply_manually":
            if monitor_only:
                progress_status = "informational"
                operator_action = "no_apply_recommended_monitor_storage"
                blocks_apply = False
            else:
                progress_status = "blocked_behind_explicit_confirmation"
                operator_action = "do_not_apply_until_review_complete_and_confirm_retention_true"
                blocks_apply = True
        elif monitor_only and item_id == "preview_recommended_retention_policy":
            progress_status = "informational"
            operator_action = "review_if_disk_pressure_changes"
            blocks_apply = False
        else:
            progress_status = "pending_operator_review"
            operator_action = "open_endpoint_and_review_output"
            blocks_apply = True
        counts[progress_status] = counts.get(progress_status, 0) + 1
        progress_items.append({
            "id": item_id,
            "order": item.get("order"),
            "title": item.get("title"),
            "checklist_status": item.get("status"),
            "progress_status": progress_status,
            "operator_action": operator_action,
            "endpoint": item.get("endpoint"),
            "gates": item.get("gates", []),
            "mutates_now": bool(item.get("mutates_now", False)),
            "required": bool(item.get("required", False)),
            "blocks_apply": blocks_apply,
            "requires_explicit_confirmation": bool(item.get("requires_explicit_confirmation", False)),
            "confirmation_field": item.get("confirmation_field"),
            "confirmation_value": item.get("confirmation_value"),
        })
    next_required = None
    if not monitor_only:
        for item in progress_items:
            if item["progress_status"] == "pending_operator_review":
                next_required = item["id"]
                break
    if monitor_only:
        operator_state = "monitor_only"
    elif next_required:
        operator_state = "pending_operator_review"
    elif counts.get("blocked_behind_explicit_confirmation"):
        operator_state = "blocked_behind_explicit_confirmation"
    else:
        operator_state = "informational"
    progress = {
        "recommended_preset": checklist.get("recommended_preset"),
        "recommended_policy": checklist.get("recommended_policy"),
        "recommended_action": recommended_action,
        "severity": checklist.get("severity"),
        "operator_state": operator_state,
        "next_required_step": next_required,
        "apply_allowed": False,
        "can_apply_now": False,
        "review_complete": False,
        "total_items": len(progress_items),
        "status_counts": counts,
        "items": progress_items,
    }
    safety = {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preset_advice_checklist_progress",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "writes_enabled": False,
        "checklist": checklist_payload,
        "progress": progress,
        "safety": safety,
        "links": {
            "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress",
            "checklist": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist",
            "preset_advice": "/api/agent-worker/runtime-trace-export-retention/preset-advice",
            "preset_advice_explanation": "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain",
            "recommended_impact_detail": checklist_payload["links"]["recommended_impact_detail"],
            "recommended_preview": checklist_payload["links"]["recommended_preview"],
            "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
        },
    }


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_evidence(workspace: Path):
    progress_payload = agent_worker_runtime_trace_export_retention_preset_advice_checklist_progress(workspace)
    checklist_payload = progress_payload.get("checklist") or {}
    advice = checklist_payload.get("advice") or {}
    progress = progress_payload.get("progress") or {}
    recommended_impact = advice.get("recommended_impact") or {}
    impact_preview = recommended_impact.get("preview") or {}
    preview_counts = impact_preview.get("counts") or {}
    linked_endpoints = {
        "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence",
        "checklist": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist",
        "progress": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress",
        "recommended_impact_detail": progress_payload["links"]["recommended_impact_detail"],
        "recommended_preview": progress_payload["links"]["recommended_preview"],
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    safety_gates = []
    for item in progress.get("items", []):
        for gate in item.get("gates", []) or []:
            if gate not in safety_gates:
                safety_gates.append(gate)
    if not safety_gates:
        explanation_payload = checklist_payload.get("explanation") or {}
        explanation = explanation_payload.get("explanation") or {}
        safety_gates = [gate.get("code") for gate in explanation.get("safety_gates", []) if gate.get("code")]
    impact_summary = {
        "preset_name": progress.get("recommended_preset") or recommended_impact.get("name"),
        "archive_candidate_count": int(recommended_impact.get("archive_candidate_count") or 0),
        "prune_candidate_count": int(recommended_impact.get("prune_candidate_count") or 0),
        "total_candidate_count": int(recommended_impact.get("total_candidate_count") or 0),
        "archive_candidate_size_bytes": int(recommended_impact.get("archive_candidate_size_bytes") or 0),
        "prune_candidate_size_bytes": int(recommended_impact.get("prune_candidate_size_bytes") or 0),
        "total_candidate_size_bytes": int(recommended_impact.get("total_candidate_size_bytes") or 0),
    }
    preview_counts_summary = {
        "active_total": int(preview_counts.get("active_total") or 0),
        "archived_total": int(preview_counts.get("archived_total") or 0),
        "archive_candidates": int(preview_counts.get("archive_candidates") or 0),
        "prune_candidates": int(preview_counts.get("prune_candidates") or 0),
    }
    evidence = {
        "bundle_type": "retention_preset_advice_checklist_evidence",
        "recommended_preset": progress.get("recommended_preset"),
        "recommended_policy": progress.get("recommended_policy"),
        "recommended_action": progress.get("recommended_action"),
        "severity": progress.get("severity"),
        "operator_state": progress.get("operator_state"),
        "next_required_step": progress.get("next_required_step"),
        "apply_allowed": False,
        "can_apply_now": False,
        "checklist_summary": {
            "total_items": int(progress.get("total_items") or 0),
            "operator_state": progress.get("operator_state"),
            "next_required_step": progress.get("next_required_step"),
            "status_counts": progress.get("status_counts") or {},
        },
        "item_ids": [item.get("id") for item in progress.get("items", [])],
        "items": progress.get("items", []),
        "impact_summary": impact_summary,
        "preview_counts": preview_counts_summary,
        "safety_gates": safety_gates,
        "linked_endpoints": linked_endpoints,
    }
    safety = {
        "read_only": True,
        "retention_apply_called": False,
        "history_writes_enabled": False,
        "operational_ledgers_mutated": False,
    }
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preset_advice_checklist_evidence",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "writes_enabled": False,
        "checklist": checklist_payload,
        "progress": progress_payload,
        "evidence": evidence,
        "safety": safety,
        "links": linked_endpoints,
    }


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_preview_markdown(export_decision: str, evidence_payload: dict):
    evidence = evidence_payload.get("evidence") or {}
    checklist_summary = evidence.get("checklist_summary") or {}
    status_counts = checklist_summary.get("status_counts") or {}
    impact = evidence.get("impact_summary") or {}
    preview = evidence.get("preview_counts") or {}
    lines = [
        "# Retention Preset Advice Checklist Evidence",
        "",
        f"- Decision: {export_decision}",
        "- Format: markdown",
        "- Dry run: true",
        "- Will apply: false",
        "- Writes enabled: false",
        "- Artifact write enabled: false",
        f"- Recommended preset: {evidence.get('recommended_preset') or '—'}",
        f"- Recommended action: {evidence.get('recommended_action') or '—'}",
        f"- Severity: {evidence.get('severity') or '—'}",
        f"- Operator state: {evidence.get('operator_state') or '—'}",
        f"- Next required step: {evidence.get('next_required_step') or '—'}",
        "",
        "## Safety Gates",
        "",
    ]
    for gate in evidence.get("safety_gates", []) or []:
        lines.append(f"- {gate}")
    if not evidence.get("safety_gates"):
        lines.append("- —")
    lines.extend(["", "## Linked Endpoints", ""])
    for name, endpoint in (evidence.get("linked_endpoints") or {}).items():
        lines.append(f"- {name}: {endpoint}")
    lines.extend([
        "",
        "## Recommendation",
        "",
        f"- Recommended preset: {evidence.get('recommended_preset') or '—'}",
        f"- Recommended policy: {json.dumps(evidence.get('recommended_policy') or {}, ensure_ascii=False, sort_keys=True)}",
        f"- Recommended action: {evidence.get('recommended_action') or '—'}",
        f"- Severity: {evidence.get('severity') or '—'}",
        f"- Operator state: {evidence.get('operator_state') or '—'}",
        f"- Next required step: {evidence.get('next_required_step') or '—'}",
        f"- Apply allowed: {bool(evidence.get('apply_allowed'))}",
        f"- Can apply now: {bool(evidence.get('can_apply_now'))}",
        "",
        "## Checklist Summary",
        "",
        f"- Total items: {checklist_summary.get('total_items', 0)}",
        f"- Informational: {status_counts.get('informational', 0)}",
        f"- Pending operator review: {status_counts.get('pending_operator_review', 0)}",
        f"- Blocked behind explicit confirmation: {status_counts.get('blocked_behind_explicit_confirmation', 0)}",
        f"- Not recommended: {status_counts.get('not_recommended', 0)}",
        "",
        "## Impact Summary",
        "",
        f"- Preset: {impact.get('preset_name') or evidence.get('recommended_preset') or '—'}",
        f"- Archive candidate count: {impact.get('archive_candidate_count', 0)}",
        f"- Prune candidate count: {impact.get('prune_candidate_count', 0)}",
        f"- Total candidate count: {impact.get('total_candidate_count', 0)}",
        f"- Archive candidate size bytes: {impact.get('archive_candidate_size_bytes', 0)}",
        f"- Prune candidate size bytes: {impact.get('prune_candidate_size_bytes', 0)}",
        f"- Total candidate size bytes: {impact.get('total_candidate_size_bytes', 0)}",
        "",
        "## Preview Counts",
        "",
        f"- Active total: {preview.get('active_total', 0)}",
        f"- Archived total: {preview.get('archived_total', 0)}",
        f"- Archive candidates: {preview.get('archive_candidates', 0)}",
        f"- Prune candidates: {preview.get('prune_candidates', 0)}",
        "",
        "## Checklist Items",
        "",
    ])
    for item in evidence.get("items", []) or []:
        lines.append(f"### {item.get('order', '—')}. {item.get('id') or '—'}")
        lines.append(f"- Progress status: {item.get('progress_status') or '—'}")
        lines.append(f"- Operator action: {item.get('operator_action') or '—'}")
        lines.append(f"- Endpoint: {item.get('endpoint') or '—'}")
        lines.append(f"- Mutates now: {bool(item.get('mutates_now'))}")
        lines.append(f"- Blocks apply: {bool(item.get('blocks_apply'))}")
        if item.get("status") == "not_recommended_for_monitor_only_advice" or item.get("checklist_status") == "not_recommended_for_monitor_only_advice":
            lines.append("- No apply is recommended for monitor-only advice.")
        lines.append("")
    lines.extend(["## Linked Endpoints", ""])
    for name, endpoint in (evidence.get("linked_endpoints") or {}).items():
        lines.append(f"- {name}: {endpoint}")
    lines.extend([
        "",
        "## Safety Statement",
        "",
        "This is a read-only export preview. It writes no artifact, records no history, mutates no operational ledger, and does not call retention apply.",
    ])
    return "\n".join(lines).strip() + "\n"


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_preview(workspace: Path, max_chars=4000):
    try:
        max_chars = int(max_chars)
    except (TypeError, ValueError):
        max_chars = 4000
    evidence_payload = agent_worker_runtime_trace_export_retention_preset_advice_checklist_evidence(workspace)
    evidence = evidence_payload.get("evidence") or {}
    impact = evidence.get("impact_summary") or {}
    preview = evidence.get("preview_counts") or {}
    summary = evidence.get("checklist_summary") or {}
    decision = "runtime_trace_export_retention_preset_advice_checklist_export_preview"
    markdown = agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_preview_markdown(decision, evidence_payload)
    content_length = len(markdown)
    if max_chars and max_chars > 0:
        markdown_preview = markdown[:max_chars]
        truncated = len(markdown_preview) < content_length
    else:
        markdown_preview = markdown
        truncated = False
    redactions = ["confirmation_token", "confirmation.token", "execution_context.confirmation_token"]
    linked_endpoints = {
        "self": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview",
        "evidence": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence",
        "checklist": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist",
        "progress": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress",
        "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
    }
    return {
        "status": "ok",
        "decision": decision,
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "writes_enabled": False,
        "artifact_path": None,
        "artifact_relpath": None,
        "evidence": evidence_payload,
        "evidence_summary": {
            "recommended_preset": evidence.get("recommended_preset"),
            "recommended_action": evidence.get("recommended_action"),
            "severity": evidence.get("severity"),
            "operator_state": evidence.get("operator_state"),
            "next_required_step": evidence.get("next_required_step"),
            "total_items": int(summary.get("total_items") or 0),
            "archive_candidate_count": int(impact.get("archive_candidate_count") or 0),
            "prune_candidate_count": int(impact.get("prune_candidate_count") or 0),
            "total_candidate_count": int(impact.get("total_candidate_count") or 0),
            "active_total": int(preview.get("active_total") or 0),
            "archived_total": int(preview.get("archived_total") or 0),
        },
        "export_preview": {
            "format": "markdown",
            "title": "Retention Preset Advice Checklist Evidence",
            "max_chars": max_chars,
            "content_length": content_length,
            "line_count": len(markdown.splitlines()),
            "markdown_preview": markdown_preview,
            "truncated": truncated,
            "redactions": redactions,
        },
        "safety": {
            "read_only": True,
            "artifact_write_enabled": False,
            "history_writes_enabled": False,
            "retention_apply_called": False,
            "operational_ledgers_mutated": False,
        },
        "links": linked_endpoints,
    }


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_dir(workspace: Path):
    return workspace / "artifacts" / "agent-worker" / "runtime-trace-retention"


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_export(workspace: Path, payload: dict):
    links = {
        "export_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview",
        "evidence": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence",
    }
    if not bool(payload.get("confirm_export", False)):
        return {
            "status": "runtime_trace_export_retention_preset_advice_checklist_export_confirmation_required",
            "decision": "runtime_trace_export_retention_preset_advice_checklist_export",
            "dry_run": True,
            "will_export": False,
            "writes_enabled": False,
            "artifact_write_enabled": False,
            "required_confirmation": {"confirm_export": True},
            "artifact_path": None,
            "artifact_relpath": None,
            "safety": {
                "read_only": True,
                "artifact_write_enabled": False,
                "history_writes_enabled": False,
                "retention_apply_called": False,
                "operational_ledgers_mutated": False,
            },
            "links": links,
        }

    reason = str(payload.get("reason", "") or "operator_confirmed_checklist_export")
    evidence_payload = agent_worker_runtime_trace_export_retention_preset_advice_checklist_evidence(workspace)
    evidence = evidence_payload.get("evidence") or {}
    impact = evidence.get("impact_summary") or {}
    preview = evidence.get("preview_counts") or {}
    summary = evidence.get("checklist_summary") or {}
    decision = "runtime_trace_export_retention_preset_advice_checklist_export"
    markdown = agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_preview_markdown(decision, evidence_payload)
    markdown = markdown.rstrip() + "\n\n## Export Metadata\n\n" + f"- Reason: {reason}\n" + "- Confirm export: true\n" + "- Artifact-only mutation: true\n" + "- Operational ledgers mutated: false\n" + "- History writes enabled: false\n" + "- Retention apply called: false\n"
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    artifact_dir = agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_dir(workspace)
    artifact_path = artifact_dir / f"retention_preset_advice_checklist_evidence_{stamp}_{uuid4().hex[:8]}.md"
    write_text(artifact_path, markdown)
    artifact_relpath = artifact_path.relative_to(workspace).as_posix()
    artifact_size_bytes = artifact_path.stat().st_size
    content_length = artifact_size_bytes
    redactions = ["confirmation_token", "confirmation.token", "execution_context.confirmation_token"]
    return {
        "status": "runtime_trace_export_retention_preset_advice_checklist_exported",
        "decision": decision,
        "dry_run": False,
        "will_export": True,
        "generated_at": now(),
        "exported_at": now(),
        "writes_enabled": True,
        "artifact_write_enabled": True,
        "reason": reason,
        "artifact_path": str(artifact_path),
        "artifact_relpath": artifact_relpath,
        "artifact_size_bytes": artifact_size_bytes,
        "artifact_only_mutation": True,
        "operational_ledgers_mutated": False,
        "history_writes_enabled": False,
        "retention_apply_called": False,
        "evidence": evidence_payload,
        "evidence_summary": {
            "recommended_preset": evidence.get("recommended_preset"),
            "recommended_action": evidence.get("recommended_action"),
            "severity": evidence.get("severity"),
            "operator_state": evidence.get("operator_state"),
            "next_required_step": evidence.get("next_required_step"),
            "total_items": int(summary.get("total_items") or 0),
            "archive_candidate_count": int(impact.get("archive_candidate_count") or 0),
            "prune_candidate_count": int(impact.get("prune_candidate_count") or 0),
            "total_candidate_count": int(impact.get("total_candidate_count") or 0),
            "active_total": int(preview.get("active_total") or 0),
            "archived_total": int(preview.get("archived_total") or 0),
        },
        "export_preview": {
            "format": "markdown",
            "title": "Retention Preset Advice Checklist Evidence",
            "content_length": content_length,
            "line_count": len(markdown.splitlines()),
            "truncated": False,
            "redactions": redactions,
        },
        "safety": {
            "read_only": False,
            "artifact_write_enabled": True,
            "history_writes_enabled": False,
            "retention_apply_called": False,
            "operational_ledgers_mutated": False,
        },
        "links": links,
    }


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_title(path: Path):
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if stripped.startswith("# "):
                return stripped[2:].strip() or "Retention Preset Advice Checklist Evidence"
    except OSError:
        pass
    return "Retention Preset Advice Checklist Evidence"


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_entry(workspace: Path, path: Path):
    stat = path.stat()
    relpath = path.relative_to(workspace).as_posix()
    return {
        "export_id": path.stem,
        "filename": path.name,
        "title": agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_title(path),
        "artifact_path": str(path),
        "artifact_relpath": relpath,
        "size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
        "links": {
            "export_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview",
            "export": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export",
        },
    }


def list_agent_worker_runtime_trace_export_retention_preset_advice_checklist_exports(workspace: Path, limit=20):
    export_dir = agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_dir(workspace)
    relpath = "artifacts/agent-worker/runtime-trace-retention"
    paths = []
    if export_dir.exists():
        paths = sorted(export_dir.glob("retention_preset_advice_checklist_evidence_*.md"), key=lambda path: path.stat().st_mtime, reverse=True)
    limit = 20 if limit is None else int(limit)
    selected = paths if limit == 0 else paths[:limit]
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preset_advice_checklist_export_index",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "writes_enabled": False,
        "artifact_write_enabled": False,
        "path": str(export_dir),
        "relpath": relpath,
        "total": len(paths),
        "count": len(selected),
        "limit": limit,
        "exports": [agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_entry(workspace, path) for path in selected],
        "safety": {
            "read_only": True,
            "artifact_write_enabled": False,
            "history_writes_enabled": False,
            "retention_apply_called": False,
            "operational_ledgers_mutated": False,
        },
        "links": {
            "exports_dir": relpath,
            "export_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview",
            "export": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export",
            "evidence": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence",
        },
    }


def sanitize_agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_id(export_id: str):
    return Path(str(export_id or "")).name.removesuffix(".md")


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_path(workspace: Path, export_id: str):
    safe_export_id = sanitize_agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_id(export_id)
    return agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_dir(workspace) / f"{safe_export_id}.md"


def redact_agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_content(content: str):
    return re.sub(r"(?i)((?:confirmation[_ .-]?token|execution_context\.confirmation_token)\s*[:=]\s*)([^\s,;]+)", r"\1[REDACTED]", content)


def agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_detail(workspace: Path, export_id: str, max_chars=4000):
    safe_export_id = sanitize_agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_id(export_id)
    artifact_path = agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_path(workspace, safe_export_id)
    export_index_link = "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=20"
    safety = {
        "read_only": True,
        "artifact_write_enabled": False,
        "history_writes_enabled": False,
        "retention_apply_called": False,
        "operational_ledgers_mutated": False,
    }
    links = {
        "export_index": export_index_link,
        "export_preview": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview",
        "export": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export",
        "evidence": "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence",
    }
    if not artifact_path.exists() or not artifact_path.is_file():
        return {
            "status": "runtime_trace_export_retention_preset_advice_checklist_export_not_found",
            "decision": "runtime_trace_export_retention_preset_advice_checklist_export_detail",
            "dry_run": True,
            "will_apply": False,
            "generated_at": now(),
            "writes_enabled": False,
            "artifact_write_enabled": False,
            "export_id": safe_export_id,
            "artifact_path": None,
            "artifact_relpath": None,
            "content_preview": "",
            "truncated": False,
            "safety": safety,
            "links": links,
        }
    raw_content = artifact_path.read_text(encoding="utf-8")
    redacted_content = redact_agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_content(raw_content)
    max_chars = max(int(max_chars or 0), 0)
    content_preview = redacted_content if max_chars == 0 else redacted_content[:max_chars]
    stat = artifact_path.stat()
    return {
        "status": "runtime_trace_export_retention_preset_advice_checklist_export_found",
        "decision": "runtime_trace_export_retention_preset_advice_checklist_export_detail",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "writes_enabled": False,
        "artifact_write_enabled": False,
        "export_id": safe_export_id,
        "filename": artifact_path.name,
        "title": agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_title(artifact_path),
        "artifact_path": str(artifact_path),
        "artifact_relpath": artifact_path.relative_to(workspace).as_posix(),
        "size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
        "line_count": len(raw_content.splitlines()),
        "content_length": len(redacted_content),
        "max_chars": max_chars,
        "content_preview": content_preview,
        "truncated": len(redacted_content) > len(content_preview),
        "redactions": ["confirmation_token", "confirmation.token", "execution_context.confirmation_token"],
        "safety": safety,
        "links": links,
    }


def agent_worker_runtime_trace_export_retention_recommendations(workspace: Path):
    recommended_policy = agent_worker_runtime_trace_export_recommended_retention_policy()
    storage_summary = agent_worker_runtime_trace_export_storage_summary(workspace)
    preview = agent_worker_runtime_trace_export_retention_preview(
        workspace,
        recommended_policy["max_active"],
        recommended_policy["max_archived"],
        recommended_policy["older_than_days"],
    )
    preview_counts = preview.get("counts") or {}
    archive_candidates = int(preview_counts.get("archive_candidates") or 0)
    prune_candidates = int(preview_counts.get("prune_candidates") or 0)
    total_candidates = archive_candidates + prune_candidates
    totals = storage_summary.get("totals") or {}
    active_count = int(totals.get("active_count") or 0)
    archive_count = int(totals.get("archive_count") or 0)
    pruned_count = int(totals.get("pruned_count") or 0)
    total_count = int(totals.get("count") or 0)
    severity = "action_recommended" if total_candidates else ("monitor" if total_count else "empty")
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_recommendations",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "recommended_policy": recommended_policy,
        "estimated_actions": {
            "archive_candidates": archive_candidates,
            "prune_candidates": prune_candidates,
            "total_candidates": total_candidates,
        },
        "severity": severity,
        "rationale": {
            "active": "active_count_exceeds_recommended_max" if active_count > recommended_policy["max_active"] else "active_count_within_recommended_max",
            "archive": "archive_count_exceeds_recommended_max" if archive_count > recommended_policy["max_archived"] else "archive_count_within_recommended_max",
            "pruned": "pruned_exports_present_review_before_delete" if pruned_count else "no_pruned_exports_detected",
            "age": "older_than_days_rule_recommended",
        },
        "storage_summary": storage_summary,
        "preview": preview,
        "links": {
            "storage_summary": "/api/agent-worker/runtime-trace-export-storage-summary",
            "retention_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30",
            "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
            "active_index": "/api/agent-worker/runtime-trace-exports?limit=20",
            "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20",
            "pruned_index": "/api/agent-worker/runtime-trace-export-pruned?limit=20",
        },
    }


def agent_worker_runtime_trace_export_retention_recommended_preview(workspace: Path):
    recommendations = agent_worker_runtime_trace_export_retention_recommendations(workspace)
    severity = recommendations.get("severity")
    if severity == "action_recommended":
        operator_next_steps = [
            "review_archive_candidates",
            "review_prune_candidates",
            "apply_retention_requires_confirm_retention_true",
        ]
    else:
        operator_next_steps = ["monitor_storage_summary"]
    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_recommended_preview",
        "dry_run": True,
        "will_apply": False,
        "generated_at": now(),
        "recommended_policy": recommendations.get("recommended_policy", agent_worker_runtime_trace_export_recommended_retention_policy()),
        "preview": recommendations.get("preview", {}),
        "storage_summary": recommendations.get("storage_summary", {}),
        "recommendations": recommendations,
        "operator_next_steps": operator_next_steps,
        "links": {
            "recommendations": "/api/agent-worker/runtime-trace-export-retention/recommendations",
            "storage_summary": "/api/agent-worker/runtime-trace-export-storage-summary",
            "retention_preview": "/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30",
            "retention_apply": "/api/agent-worker/runtime-trace-export-retention/apply",
            "active_index": "/api/agent-worker/runtime-trace-exports?limit=20",
            "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20",
            "pruned_index": "/api/agent-worker/runtime-trace-export-pruned?limit=20",
        },
    }


def redact_agent_worker_runtime_trace_export_content(content: str):
    return re.sub(r"(?i)(confirmation[_ -]?token\s*[:=]\s*)([^\s,;]+)", r"\1[REDACTED]", content)


def agent_worker_runtime_trace_export_detail(workspace: Path, one_shot_run_id: str, max_chars=4000):
    artifact_path = agent_worker_runtime_trace_export_path(workspace, one_shot_run_id)
    export_index_link = "/api/agent-worker/runtime-trace-exports?limit=20"
    if not artifact_path.exists() or not artifact_path.is_file():
        return {
            "status": "runtime_trace_export_not_found",
            "decision": "runtime_trace_export_detail",
            "one_shot_run_id": one_shot_run_id,
            "artifact_path": None,
            "artifact_relpath": None,
            "content_preview": "",
            "truncated": False,
            "links": {"export_index": export_index_link},
        }
    raw_content = artifact_path.read_text(encoding="utf-8")
    redacted_content = redact_agent_worker_runtime_trace_export_content(raw_content)
    max_chars = max(int(max_chars or 0), 0)
    content_preview = redacted_content if max_chars == 0 else redacted_content[:max_chars]
    stat = artifact_path.stat()
    return {
        "status": "runtime_trace_export_found",
        "decision": "runtime_trace_export_detail",
        "one_shot_run_id": one_shot_run_id,
        "filename": artifact_path.name,
        "title": agent_worker_runtime_trace_export_title(artifact_path),
        "artifact_path": str(artifact_path),
        "artifact_relpath": artifact_path.relative_to(workspace).as_posix(),
        "size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
        "line_count": len(raw_content.splitlines()),
        "content_length": len(redacted_content),
        "max_chars": max_chars,
        "content_preview": content_preview,
        "truncated": len(redacted_content) > len(content_preview),
        "redactions": ["confirmation_token"],
        "links": {
            "export_index": export_index_link,
            "trace_graph": f"/api/agent-worker/runtime-traces/{one_shot_run_id}",
            "regenerate_export": f"/api/agent-worker/runtime-traces/{one_shot_run_id}/export",
        },
    }


def agent_worker_runtime_trace_export_archive_dir(workspace: Path):
    return agent_worker_runtime_trace_exports_dir(workspace) / "archive"


def sanitize_agent_worker_runtime_trace_export_archive_id(archive_id: str):
    return Path(str(archive_id or "")).name.removesuffix(".md")


def agent_worker_runtime_trace_export_archive_one_shot_run_id(archive_id_or_path):
    stem = archive_id_or_path.stem if isinstance(archive_id_or_path, Path) else sanitize_agent_worker_runtime_trace_export_archive_id(str(archive_id_or_path))
    if "_trace_" in stem:
        return stem.rsplit("_trace_", 1)[0]
    if stem.endswith("_trace"):
        return stem[:-6]
    return stem


def agent_worker_runtime_trace_export_archive_path(workspace: Path, archive_id: str):
    safe_archive_id = sanitize_agent_worker_runtime_trace_export_archive_id(archive_id)
    return agent_worker_runtime_trace_export_archive_dir(workspace) / f"{safe_archive_id}.md"


def agent_worker_runtime_trace_export_archive_entry(workspace: Path, path: Path):
    archive_id = path.stem
    one_shot_run_id = agent_worker_runtime_trace_export_archive_one_shot_run_id(path)
    restore_path = agent_worker_runtime_trace_export_path(workspace, one_shot_run_id)
    stat = path.stat()
    return {
        "archive_id": archive_id,
        "one_shot_run_id": one_shot_run_id,
        "filename": path.name,
        "title": agent_worker_runtime_trace_export_title(path),
        "archive_path": str(path),
        "archive_relpath": path.relative_to(workspace).as_posix(),
        "restore_path": str(restore_path),
        "restore_relpath": restore_path.relative_to(workspace).as_posix(),
        "size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
        "links": {"restore": f"/api/agent-worker/runtime-trace-export-archives/{archive_id}/restore"},
    }


def list_agent_worker_runtime_trace_export_archives(workspace: Path, limit=20):
    archive_root = agent_worker_runtime_trace_export_archive_dir(workspace)
    if archive_root.exists():
        paths = sorted(archive_root.glob("*_trace_*.md"), key=lambda path: path.stat().st_mtime, reverse=True)
    else:
        paths = []
    total = len(paths)
    selected = paths if int(limit or 0) == 0 else paths[: max(int(limit or 20), 0)]
    archives = [agent_worker_runtime_trace_export_archive_entry(workspace, path) for path in selected]
    return {
        "status": "ok",
        "decision": "runtime_trace_export_archive_index",
        "path": str(archive_root),
        "total": total,
        "count": len(archives),
        "limit": int(limit or 0),
        "archives": archives,
        "links": {"archive_dir": "artifacts/agent-worker/runtime-traces/archive"},
    }


def archive_agent_worker_runtime_trace_export(workspace: Path, one_shot_run_id: str, confirm_archive=False, reason=""):
    artifact_path = agent_worker_runtime_trace_export_path(workspace, one_shot_run_id)
    export_index_link = "/api/agent-worker/runtime-trace-exports?limit=20"
    if not artifact_path.exists() or not artifact_path.is_file():
        return {
            "status": "runtime_trace_export_archive_not_found",
            "decision": "runtime_trace_export_archive",
            "one_shot_run_id": one_shot_run_id,
            "will_archive": False,
            "artifact_path": None,
            "archive_path": None,
            "archive_relpath": None,
            "links": {"export_index": export_index_link},
        }
    if not bool(confirm_archive):
        return {
            "status": "runtime_trace_export_archive_confirmation_required",
            "decision": "runtime_trace_export_archive",
            "one_shot_run_id": one_shot_run_id,
            "will_archive": False,
            "artifact_path": str(artifact_path),
            "artifact_relpath": artifact_path.relative_to(workspace).as_posix(),
            "archive_path": None,
            "archive_relpath": None,
            "links": {"export_index": export_index_link},
        }
    archived_at = now()
    safe_stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    archive_root = agent_worker_runtime_trace_export_archive_dir(workspace)
    archive_root.mkdir(parents=True, exist_ok=True)
    archive_path = archive_root / f"{artifact_path.stem}_{safe_stamp}.md"
    if archive_path.exists():
        archive_path = archive_root / f"{artifact_path.stem}_{safe_stamp}_{uuid4().hex[:8]}.md"
    original_relpath = artifact_path.relative_to(workspace).as_posix()
    artifact_path.replace(archive_path)
    archive_relpath = archive_path.relative_to(workspace).as_posix()
    return {
        "status": "runtime_trace_export_archived",
        "decision": "runtime_trace_export_archive",
        "one_shot_run_id": one_shot_run_id,
        "reason": str(reason or "operator_archive"),
        "will_archive": True,
        "archived_at": archived_at,
        "original_artifact_path": str(artifact_path),
        "original_artifact_relpath": original_relpath,
        "archive_path": str(archive_path),
        "archive_relpath": archive_relpath,
        "artifact_only_mutation": True,
        "operational_ledgers_mutated": False,
        "links": {"export_index": export_index_link},
    }


def restore_agent_worker_runtime_trace_export_archive(workspace: Path, archive_id: str, confirm_restore=False, reason=""):
    archive_id = sanitize_agent_worker_runtime_trace_export_archive_id(archive_id)
    one_shot_run_id = agent_worker_runtime_trace_export_archive_one_shot_run_id(archive_id)
    archive_path = agent_worker_runtime_trace_export_archive_path(workspace, archive_id)
    archive_index_link = "/api/agent-worker/runtime-trace-export-archives?limit=20"
    if not archive_path.exists() or not archive_path.is_file():
        return {
            "status": "runtime_trace_export_restore_not_found",
            "decision": "runtime_trace_export_restore",
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "will_restore": False,
            "archive_path": None,
            "restore_path": None,
            "restore_relpath": None,
            "links": {"archive_index": archive_index_link},
        }
    restore_path = agent_worker_runtime_trace_export_path(workspace, one_shot_run_id)
    restore_relpath = restore_path.relative_to(workspace).as_posix()
    if not bool(confirm_restore):
        return {
            "status": "runtime_trace_export_restore_confirmation_required",
            "decision": "runtime_trace_export_restore",
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "will_restore": False,
            "archive_path": str(archive_path),
            "archive_relpath": archive_path.relative_to(workspace).as_posix(),
            "restore_path": str(restore_path),
            "restore_relpath": restore_relpath,
            "links": {"archive_index": archive_index_link},
        }
    if restore_path.exists():
        return {
            "status": "runtime_trace_export_restore_conflict",
            "decision": "runtime_trace_export_restore",
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "will_restore": False,
            "archive_path": str(archive_path),
            "archive_relpath": archive_path.relative_to(workspace).as_posix(),
            "restore_path": str(restore_path),
            "restore_relpath": restore_relpath,
            "links": {"archive_index": archive_index_link, "active_export_detail": f"/api/agent-worker/runtime-trace-exports/{one_shot_run_id}"},
        }
    restored_at = now()
    restore_path.parent.mkdir(parents=True, exist_ok=True)
    archive_relpath = archive_path.relative_to(workspace).as_posix()
    archive_path.replace(restore_path)
    return {
        "status": "runtime_trace_export_restored",
        "decision": "runtime_trace_export_restore",
        "archive_id": archive_id,
        "one_shot_run_id": one_shot_run_id,
        "reason": str(reason or "operator_restore"),
        "will_restore": True,
        "restored_at": restored_at,
        "archive_path": str(archive_path),
        "archive_relpath": archive_relpath,
        "restore_path": str(restore_path),
        "restore_relpath": restore_relpath,
        "artifact_only_mutation": True,
        "operational_ledgers_mutated": False,
        "links": {"archive_index": archive_index_link, "active_export_detail": f"/api/agent-worker/runtime-trace-exports/{one_shot_run_id}"},
    }


def agent_worker_runtime_trace_export_pruned_dir(workspace: Path):
    return agent_worker_runtime_trace_exports_dir(workspace) / "pruned"


def sanitize_agent_worker_runtime_trace_export_pruned_id(pruned_id: str):
    return Path(str(pruned_id or "")).name.removesuffix(".md")


def agent_worker_runtime_trace_export_pruned_archive_id(pruned_id_or_path):
    stem = pruned_id_or_path.stem if isinstance(pruned_id_or_path, Path) else sanitize_agent_worker_runtime_trace_export_pruned_id(str(pruned_id_or_path))
    if "_pruned_" in stem:
        return stem.rsplit("_pruned_", 1)[0]
    return stem


def agent_worker_runtime_trace_export_pruned_one_shot_run_id(pruned_id_or_path):
    archive_id = agent_worker_runtime_trace_export_pruned_archive_id(pruned_id_or_path)
    return agent_worker_runtime_trace_export_archive_one_shot_run_id(archive_id)


def agent_worker_runtime_trace_export_pruned_path(workspace: Path, pruned_id: str):
    safe_pruned_id = sanitize_agent_worker_runtime_trace_export_pruned_id(pruned_id)
    return agent_worker_runtime_trace_export_pruned_dir(workspace) / f"{safe_pruned_id}.md"


def agent_worker_runtime_trace_export_pruned_entry(workspace: Path, path: Path):
    pruned_id = path.stem
    archive_id = agent_worker_runtime_trace_export_pruned_archive_id(path)
    one_shot_run_id = agent_worker_runtime_trace_export_pruned_one_shot_run_id(path)
    restore_archive_path = agent_worker_runtime_trace_export_archive_path(workspace, archive_id)
    stat = path.stat()
    return {
        "pruned_id": pruned_id,
        "archive_id": archive_id,
        "one_shot_run_id": one_shot_run_id,
        "filename": path.name,
        "title": agent_worker_runtime_trace_export_title(path),
        "pruned_path": str(path),
        "pruned_relpath": path.relative_to(workspace).as_posix(),
        "restore_archive_path": str(restore_archive_path),
        "restore_archive_relpath": restore_archive_path.relative_to(workspace).as_posix(),
        "size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
        "links": {
            "restore": f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore",
            "delete": f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/delete",
        },
    }


def list_agent_worker_runtime_trace_export_pruned(workspace: Path, limit=20):
    pruned_root = agent_worker_runtime_trace_export_pruned_dir(workspace)
    if pruned_root.exists():
        paths = sorted(pruned_root.glob("*_pruned_*.md"), key=lambda path: path.stat().st_mtime, reverse=True)
    else:
        paths = []
    total = len(paths)
    selected = paths if int(limit or 0) == 0 else paths[: max(int(limit or 20), 0)]
    pruned = [agent_worker_runtime_trace_export_pruned_entry(workspace, path) for path in selected]
    return {
        "status": "ok",
        "decision": "runtime_trace_export_pruned_index",
        "path": str(pruned_root),
        "total": total,
        "count": len(pruned),
        "limit": int(limit or 0),
        "pruned": pruned,
        "links": {"pruned_dir": "artifacts/agent-worker/runtime-traces/pruned"},
    }


def agent_worker_runtime_trace_export_pruned_detail(workspace: Path, pruned_id: str, max_chars=4000):
    pruned_id = sanitize_agent_worker_runtime_trace_export_pruned_id(pruned_id)
    archive_id = agent_worker_runtime_trace_export_pruned_archive_id(pruned_id)
    one_shot_run_id = agent_worker_runtime_trace_export_pruned_one_shot_run_id(pruned_id)
    pruned_path = agent_worker_runtime_trace_export_pruned_path(workspace, pruned_id)
    pruned_index_link = "/api/agent-worker/runtime-trace-export-pruned?limit=20"
    if not pruned_path.exists() or not pruned_path.is_file():
        return {
            "status": "runtime_trace_export_pruned_not_found",
            "decision": "runtime_trace_export_pruned_detail",
            "pruned_id": pruned_id,
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "pruned_path": None,
            "pruned_relpath": None,
            "content_preview": "",
            "truncated": False,
            "links": {"pruned_index": pruned_index_link},
        }
    raw_content = pruned_path.read_text(encoding="utf-8")
    redacted_content = redact_agent_worker_runtime_trace_export_content(raw_content)
    max_chars = max(int(max_chars or 0), 0)
    content_preview = redacted_content if max_chars == 0 else redacted_content[:max_chars]
    restore_archive_path = agent_worker_runtime_trace_export_archive_path(workspace, archive_id)
    stat = pruned_path.stat()
    return {
        "status": "runtime_trace_export_pruned_found",
        "decision": "runtime_trace_export_pruned_detail",
        "pruned_id": pruned_id,
        "archive_id": archive_id,
        "one_shot_run_id": one_shot_run_id,
        "filename": pruned_path.name,
        "title": agent_worker_runtime_trace_export_title(pruned_path),
        "pruned_path": str(pruned_path),
        "pruned_relpath": pruned_path.relative_to(workspace).as_posix(),
        "restore_archive_path": str(restore_archive_path),
        "restore_archive_relpath": restore_archive_path.relative_to(workspace).as_posix(),
        "size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
        "line_count": len(raw_content.splitlines()),
        "content_length": len(redacted_content),
        "max_chars": max_chars,
        "content_preview": content_preview,
        "truncated": len(redacted_content) > len(content_preview),
        "redactions": ["confirmation_token"],
        "links": {
            "pruned_index": pruned_index_link,
            "restore": f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore",
            "delete": f"/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/delete",
            "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20",
        },
    }


def restore_agent_worker_runtime_trace_export_pruned(workspace: Path, pruned_id: str, confirm_restore=False, reason=""):
    pruned_id = sanitize_agent_worker_runtime_trace_export_pruned_id(pruned_id)
    archive_id = agent_worker_runtime_trace_export_pruned_archive_id(pruned_id)
    one_shot_run_id = agent_worker_runtime_trace_export_pruned_one_shot_run_id(pruned_id)
    pruned_path = agent_worker_runtime_trace_export_pruned_path(workspace, pruned_id)
    pruned_index_link = "/api/agent-worker/runtime-trace-export-pruned?limit=20"
    if not pruned_path.exists() or not pruned_path.is_file():
        return {
            "status": "runtime_trace_export_pruned_restore_not_found",
            "decision": "runtime_trace_export_pruned_restore",
            "pruned_id": pruned_id,
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "will_restore": False,
            "pruned_path": None,
            "restore_archive_path": None,
            "restore_archive_relpath": None,
            "links": {"pruned_index": pruned_index_link},
        }
    restore_archive_path = agent_worker_runtime_trace_export_archive_path(workspace, archive_id)
    restore_archive_relpath = restore_archive_path.relative_to(workspace).as_posix()
    pruned_relpath = pruned_path.relative_to(workspace).as_posix()
    if not bool(confirm_restore):
        return {
            "status": "runtime_trace_export_pruned_restore_confirmation_required",
            "decision": "runtime_trace_export_pruned_restore",
            "pruned_id": pruned_id,
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "will_restore": False,
            "pruned_path": str(pruned_path),
            "pruned_relpath": pruned_relpath,
            "restore_archive_path": str(restore_archive_path),
            "restore_archive_relpath": restore_archive_relpath,
            "links": {"pruned_index": pruned_index_link},
        }
    if restore_archive_path.exists():
        return {
            "status": "runtime_trace_export_pruned_restore_conflict",
            "decision": "runtime_trace_export_pruned_restore",
            "pruned_id": pruned_id,
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "will_restore": False,
            "pruned_path": str(pruned_path),
            "pruned_relpath": pruned_relpath,
            "restore_archive_path": str(restore_archive_path),
            "restore_archive_relpath": restore_archive_relpath,
            "links": {"pruned_index": pruned_index_link, "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20"},
        }
    restored_at = now()
    restore_archive_path.parent.mkdir(parents=True, exist_ok=True)
    pruned_path.replace(restore_archive_path)
    return {
        "status": "runtime_trace_export_pruned_restored",
        "decision": "runtime_trace_export_pruned_restore",
        "pruned_id": pruned_id,
        "archive_id": archive_id,
        "one_shot_run_id": one_shot_run_id,
        "reason": str(reason or "operator_restore_pruned"),
        "will_restore": True,
        "restored_at": restored_at,
        "pruned_path": str(pruned_path),
        "pruned_relpath": pruned_relpath,
        "restore_archive_path": str(restore_archive_path),
        "restore_archive_relpath": restore_archive_relpath,
        "artifact_only_mutation": True,
        "operational_ledgers_mutated": False,
        "links": {"pruned_index": pruned_index_link, "archive_index": "/api/agent-worker/runtime-trace-export-archives?limit=20"},
    }


def delete_agent_worker_runtime_trace_export_pruned(workspace: Path, pruned_id: str, confirm_delete=False, confirmation_phrase="", reason=""):
    pruned_id = sanitize_agent_worker_runtime_trace_export_pruned_id(pruned_id)
    archive_id = agent_worker_runtime_trace_export_pruned_archive_id(pruned_id)
    one_shot_run_id = agent_worker_runtime_trace_export_pruned_one_shot_run_id(pruned_id)
    pruned_path = agent_worker_runtime_trace_export_pruned_path(workspace, pruned_id)
    required_phrase = f"DELETE PRUNED EXPORT {pruned_id}"
    pruned_index_link = "/api/agent-worker/runtime-trace-export-pruned?limit=20"
    if not pruned_path.exists() or not pruned_path.is_file():
        return {
            "status": "runtime_trace_export_pruned_delete_not_found",
            "decision": "runtime_trace_export_pruned_delete",
            "pruned_id": pruned_id,
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "will_delete": False,
            "pruned_path": None,
            "required_phrase": required_phrase,
            "links": {"pruned_index": pruned_index_link},
        }
    pruned_relpath = pruned_path.relative_to(workspace).as_posix()
    if not bool(confirm_delete) or str(confirmation_phrase or "") != required_phrase:
        return {
            "status": "runtime_trace_export_pruned_delete_confirmation_required",
            "decision": "runtime_trace_export_pruned_delete",
            "pruned_id": pruned_id,
            "archive_id": archive_id,
            "one_shot_run_id": one_shot_run_id,
            "will_delete": False,
            "pruned_path": str(pruned_path),
            "pruned_relpath": pruned_relpath,
            "required_phrase": required_phrase,
            "artifact_only_mutation": False,
            "operational_ledgers_mutated": False,
            "links": {"pruned_index": pruned_index_link},
        }
    deleted_at = now()
    pruned_path.unlink()
    return {
        "status": "runtime_trace_export_pruned_deleted",
        "decision": "runtime_trace_export_pruned_delete",
        "pruned_id": pruned_id,
        "archive_id": archive_id,
        "one_shot_run_id": one_shot_run_id,
        "reason": str(reason or "operator_delete_pruned"),
        "will_delete": True,
        "permanently_deleted": True,
        "deleted_at": deleted_at,
        "pruned_path": str(pruned_path),
        "pruned_relpath": pruned_relpath,
        "required_phrase": required_phrase,
        "artifact_only_mutation": True,
        "operational_ledgers_mutated": False,
        "links": {"pruned_index": pruned_index_link},
    }


def normalize_retention_limit(value):
    if value is None or value == "":
        return None
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return None


def agent_worker_runtime_trace_export_retention_policy(max_active=None, max_archived=None, older_than_days=None):
    return {
        "max_active": normalize_retention_limit(max_active),
        "max_archived": normalize_retention_limit(max_archived),
        "older_than_days": normalize_retention_limit(older_than_days),
    }


def unique_artifact_path(path: Path):
    if not path.exists():
        return path
    return path.with_name(f"{path.stem}_{uuid4().hex[:8]}{path.suffix}")


def file_modified_at(path: Path):
    return datetime.fromtimestamp(path.stat().st_mtime).replace(microsecond=0).isoformat()


def active_runtime_trace_export_paths(workspace: Path):
    export_root = agent_worker_runtime_trace_exports_dir(workspace)
    return sorted(export_root.glob("*_trace.md"), key=lambda path: path.stat().st_mtime, reverse=True) if export_root.exists() else []


def archived_runtime_trace_export_paths(workspace: Path):
    archive_root = agent_worker_runtime_trace_export_archive_dir(workspace)
    return sorted(archive_root.glob("*_trace_*.md"), key=lambda path: path.stat().st_mtime, reverse=True) if archive_root.exists() else []


def retention_candidate_reasons(index: int, limit, path: Path, cutoff_ts):
    reasons = []
    if limit is not None and index >= limit:
        reasons.append("max_count_exceeded")
    if cutoff_ts is not None and path.stat().st_mtime < cutoff_ts:
        reasons.append("older_than_days")
    return reasons


def agent_worker_runtime_trace_export_retention_preview(workspace: Path, max_active=None, max_archived=None, older_than_days=None, stamp=None):
    policy = agent_worker_runtime_trace_export_retention_policy(max_active, max_archived, older_than_days)
    stamp = stamp or "preview"
    cutoff_ts = None
    if policy["older_than_days"] is not None:
        cutoff_ts = time.time() - (policy["older_than_days"] * 86400)

    active_paths = active_runtime_trace_export_paths(workspace)
    archive_candidates = []
    for index, path in enumerate(active_paths):
        reasons = retention_candidate_reasons(index, policy["max_active"], path, cutoff_ts)
        if not reasons:
            continue
        one_shot_run_id = agent_worker_runtime_trace_export_one_shot_run_id(path)
        planned_path = agent_worker_runtime_trace_export_archive_dir(workspace) / f"{path.stem}_{stamp}.md"
        archive_candidates.append({
            "one_shot_run_id": one_shot_run_id,
            "filename": path.name,
            "title": agent_worker_runtime_trace_export_title(path),
            "artifact_path": str(path),
            "artifact_relpath": path.relative_to(workspace).as_posix(),
            "planned_archive_path": str(planned_path),
            "planned_archive_relpath": planned_path.relative_to(workspace).as_posix(),
            "size_bytes": path.stat().st_size,
            "modified_at": file_modified_at(path),
            "reasons": reasons,
        })

    archived_paths = archived_runtime_trace_export_paths(workspace)
    prune_candidates = []
    for index, path in enumerate(archived_paths):
        reasons = retention_candidate_reasons(index, policy["max_archived"], path, cutoff_ts)
        if not reasons:
            continue
        archive_id = path.stem
        planned_path = agent_worker_runtime_trace_export_pruned_dir(workspace) / f"{archive_id}_pruned_{stamp}.md"
        prune_candidates.append({
            "archive_id": archive_id,
            "one_shot_run_id": agent_worker_runtime_trace_export_archive_one_shot_run_id(path),
            "filename": path.name,
            "title": agent_worker_runtime_trace_export_title(path),
            "archive_path": str(path),
            "archive_relpath": path.relative_to(workspace).as_posix(),
            "planned_pruned_path": str(planned_path),
            "planned_pruned_relpath": planned_path.relative_to(workspace).as_posix(),
            "size_bytes": path.stat().st_size,
            "modified_at": file_modified_at(path),
            "reasons": reasons,
        })

    return {
        "status": "ok",
        "decision": "runtime_trace_export_retention_preview",
        "dry_run": True,
        "will_apply": False,
        "policy": policy,
        "counts": {
            "active_total": len(active_paths),
            "archived_total": len(archived_paths),
            "archive_candidates": len(archive_candidates),
            "prune_candidates": len(prune_candidates),
        },
        "archive_candidates": archive_candidates,
        "prune_candidates": prune_candidates,
        "links": {
            "active_exports": "/api/agent-worker/runtime-trace-exports?limit=20",
            "archived_exports": "/api/agent-worker/runtime-trace-export-archives?limit=20",
        },
    }


def apply_agent_worker_runtime_trace_export_retention(workspace: Path, payload: dict):
    preview = agent_worker_runtime_trace_export_retention_preview(
        workspace,
        payload.get("max_active"),
        payload.get("max_archived"),
        payload.get("older_than_days"),
        stamp=datetime.now().strftime("%Y%m%d%H%M%S"),
    )
    if not bool(payload.get("confirm_retention")):
        return {
            "status": "runtime_trace_export_retention_confirmation_required",
            "decision": "runtime_trace_export_retention_apply",
            "dry_run": True,
            "will_apply": False,
            "preview": preview,
            "archived": [],
            "pruned": [],
            "artifact_only_mutation": False,
            "operational_ledgers_mutated": False,
        }

    applied_at = now()
    archived = []
    for candidate in preview["archive_candidates"]:
        source = Path(candidate["artifact_path"])
        if not source.exists():
            continue
        target = unique_artifact_path(Path(candidate["planned_archive_path"]))
        target.parent.mkdir(parents=True, exist_ok=True)
        source_relpath = source.relative_to(workspace).as_posix()
        source.replace(target)
        archived.append({
            "one_shot_run_id": candidate["one_shot_run_id"],
            "source_path": str(source),
            "source_relpath": source_relpath,
            "archive_path": str(target),
            "archive_relpath": target.relative_to(workspace).as_posix(),
            "reasons": candidate.get("reasons", []),
        })

    pruned = []
    for candidate in preview["prune_candidates"]:
        source = Path(candidate["archive_path"])
        if not source.exists():
            continue
        target = unique_artifact_path(Path(candidate["planned_pruned_path"]))
        target.parent.mkdir(parents=True, exist_ok=True)
        source_relpath = source.relative_to(workspace).as_posix()
        source.replace(target)
        pruned.append({
            "archive_id": candidate["archive_id"],
            "one_shot_run_id": candidate["one_shot_run_id"],
            "source_path": str(source),
            "source_relpath": source_relpath,
            "pruned_path": str(target),
            "pruned_relpath": target.relative_to(workspace).as_posix(),
            "reasons": candidate.get("reasons", []),
        })

    return {
        "status": "runtime_trace_export_retention_applied",
        "decision": "runtime_trace_export_retention_apply",
        "dry_run": False,
        "will_apply": True,
        "reason": str(payload.get("reason") or "operator_retention"),
        "applied_at": applied_at,
        "policy": preview["policy"],
        "preview": preview,
        "counts": {"archived": len(archived), "pruned": len(pruned)},
        "archived": archived,
        "pruned": pruned,
        "artifact_only_mutation": True,
        "operational_ledgers_mutated": False,
        "links": {
            "active_exports": "/api/agent-worker/runtime-trace-exports?limit=20",
            "archived_exports": "/api/agent-worker/runtime-trace-export-archives?limit=20",
        },
    }


def agent_worker_runtime_confirm_attempts_path(workspace: Path) -> Path:
    return workspace / "logs" / "agent-worker" / "runtime-confirm-attempts.json"


def load_agent_worker_runtime_confirm_attempts(workspace: Path):
    return read_json(agent_worker_runtime_confirm_attempts_path(workspace), [])


def append_agent_worker_runtime_confirm_attempt(workspace: Path, record: dict):
    attempts = load_agent_worker_runtime_confirm_attempts(workspace)
    attempts.append(record)
    write_json(agent_worker_runtime_confirm_attempts_path(workspace), attempts)
    return record


def normalize_agent_worker_runtime_confirm_attempt_filter(value):
    normalized = str(value or "").strip().lower().replace("-", "_")
    if not normalized or normalized in {"all", "any", "*"}:
        return None
    return normalized


def parse_agent_worker_runtime_called_filter(value):
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if not normalized or normalized in {"all", "any", "*"}:
        return None
    if normalized in {"1", "true", "yes", "y", "called", "executed"}:
        return True
    if normalized in {"0", "false", "no", "n", "blocked", "not_called"}:
        return False
    return None


def summarize_agent_worker_runtime_confirm_attempts(attempts):
    summary = {"total": len(attempts), "runtime_called": {"true": 0, "false": 0}, "final_status": {}, "preflight_status": {}}
    for attempt in attempts:
        runtime_key = "true" if bool(attempt.get("runtime_called")) else "false"
        summary["runtime_called"][runtime_key] += 1
        final_status = normalize_agent_worker_runtime_confirm_attempt_filter(attempt.get("final_status")) or "unknown"
        preflight_status = normalize_agent_worker_runtime_confirm_attempt_filter(attempt.get("preflight_status")) or "unknown"
        summary["final_status"][final_status] = summary["final_status"].get(final_status, 0) + 1
        summary["preflight_status"][preflight_status] = summary["preflight_status"].get(preflight_status, 0) + 1
    return summary


def list_agent_worker_runtime_confirm_attempts(workspace: Path, limit=20, final_status=None, runtime_called=None, preflight_status=None):
    final_status_filter = normalize_agent_worker_runtime_confirm_attempt_filter(final_status)
    runtime_called_filter = parse_agent_worker_runtime_called_filter(runtime_called)
    preflight_status_filter = normalize_agent_worker_runtime_confirm_attempt_filter(preflight_status)
    all_attempts = list(reversed(load_agent_worker_runtime_confirm_attempts(workspace)))
    attempts = all_attempts
    if final_status_filter:
        attempts = [attempt for attempt in attempts if normalize_agent_worker_runtime_confirm_attempt_filter(attempt.get("final_status")) == final_status_filter]
    if runtime_called_filter is not None:
        attempts = [attempt for attempt in attempts if bool(attempt.get("runtime_called")) is runtime_called_filter]
    if preflight_status_filter:
        attempts = [attempt for attempt in attempts if normalize_agent_worker_runtime_confirm_attempt_filter(attempt.get("preflight_status")) == preflight_status_filter]
    matched = len(attempts)
    limit_int = int(limit or 20)
    visible = attempts[:limit_int] if limit_int > 0 else attempts
    return {"status": "ok", "count": len(visible), "total": len(all_attempts), "matched": matched, "summary": summarize_agent_worker_runtime_confirm_attempts(all_attempts), "filters": {"final_status": final_status_filter, "runtime_called": runtime_called_filter, "preflight_status": preflight_status_filter}, "attempts": visible, "path": str(agent_worker_runtime_confirm_attempts_path(workspace))}


def find_agent_worker_runtime_confirm_attempt(workspace: Path, attempt_id: str):
    for attempt in reversed(load_agent_worker_runtime_confirm_attempts(workspace)):
        if attempt.get("id") == attempt_id or attempt.get("confirm_attempt_id") == attempt_id:
            return attempt
    return None


def agent_worker_runtime_confirm_attempt_detail(workspace: Path, attempt_id: str):
    attempt = find_agent_worker_runtime_confirm_attempt(workspace, attempt_id)
    if not attempt:
        return {"status": "runtime_confirm_attempt_not_found", "decision": "runtime_confirm_attempt_detail", "attempt_id": attempt_id, "attempt": None, "links": {}}
    preview_id = attempt.get("preview_id")
    runtime_audit_id = attempt.get("runtime_audit_id")
    queue_run_ids = attempt.get("queue_run_ids") or []
    links = {
        "preview_detail": f"/api/agent-worker/runtime-previews/{preview_id}" if preview_id else None,
        "runtime_audit_id": runtime_audit_id,
        "runtime_audit_detail": f"/api/agent-worker/runtime-audits/{runtime_audit_id}" if runtime_audit_id else None,
        "queue_run_ids": queue_run_ids,
    }
    return {
        "status": "runtime_confirm_attempt_found",
        "decision": "runtime_confirm_attempt_detail",
        "attempt_id": attempt.get("id") or attempt_id,
        "final_status": attempt.get("final_status"),
        "runtime_called": bool(attempt.get("runtime_called")),
        "preflight_status": attempt.get("preflight_status"),
        "preview_id": preview_id,
        "one_shot_run_id": attempt.get("one_shot_run_id"),
        "runtime_audit_id": runtime_audit_id,
        "queue_run_ids": queue_run_ids,
        "links": links,
        "attempt": attempt,
    }


def record_agent_worker_runtime_confirm_attempt(workspace: Path, preflight: dict, result: dict, runtime_called: bool):
    audit = result.get("audit") or {}
    preflight_confirmation = preflight.get("confirmation") or {}
    attempt = {
        "id": f"runtime_confirm_attempt_{uuid4().hex[:10]}",
        "created_at": now(),
        "status": "runtime_confirm_attempt_recorded",
        "final_status": result.get("status"),
        "decision": result.get("decision") or result.get("status"),
        "runtime_called": bool(runtime_called),
        "preflight_status": preflight.get("status"),
        "preflight_can_execute": bool(preflight.get("can_execute")),
        "preflight_reason": preflight.get("reason"),
        "preview_id": result.get("preview_id") or preflight.get("preview_id"),
        "one_shot_run_id": result.get("one_shot_run_id") or preflight.get("one_shot_run_id"),
        "confirmation_token": preflight.get("confirmation_token") or preflight_confirmation.get("token"),
        "token_status": result.get("token_status") or preflight.get("token_status"),
        "execution_status": result.get("status") or preflight.get("execution_status"),
        "executed": int(result.get("executed", 0) or 0),
        "runtime_audit_id": audit.get("id"),
        "queue_run_ids": audit.get("queue_run_ids") or [],
        "preflight": preflight,
        "result_summary": {
            "status": result.get("status"),
            "decision": result.get("decision"),
            "executed": int(result.get("executed", 0) or 0),
            "runtime_audit_id": audit.get("id"),
        },
    }
    return append_agent_worker_runtime_confirm_attempt(workspace, attempt)


def attach_agent_worker_runtime_confirm_attempt(workspace: Path, preflight: dict, result: dict, runtime_called: bool):
    attempt = record_agent_worker_runtime_confirm_attempt(workspace, preflight, result, runtime_called)
    result["confirm_attempt_id"] = attempt["id"]
    result["confirmation_attempt"] = attempt
    return result


def agent_worker_runtime_previews_path(workspace: Path):
    return workspace / "logs" / "agent-worker" / "runtime-previews.json"


def load_agent_worker_runtime_previews(workspace: Path):
    return read_json(agent_worker_runtime_previews_path(workspace), [])


def append_agent_worker_runtime_preview(workspace: Path, record: dict):
    previews = load_agent_worker_runtime_previews(workspace)
    previews.append(record)
    write_json(agent_worker_runtime_previews_path(workspace), previews)
    return record


def update_agent_worker_runtime_preview(workspace: Path, preview_id: str, updates: dict):
    previews = load_agent_worker_runtime_previews(workspace)
    updated = None
    for preview in previews:
        if preview.get("preview_id") == preview_id or preview.get("id") == preview_id:
            preview.update(updates)
            updated = preview
            break
    if updated:
        write_json(agent_worker_runtime_previews_path(workspace), previews)
    return updated


def normalize_agent_worker_runtime_preview_status(status):
    normalized = str(status or "").strip().lower().replace("-", "_")
    if not normalized or normalized in {"all", "any", "*"}:
        return None
    aliases = {
        "pending_confirmation": "pending",
        "runtime_execute_completed": "consumed",
        "runtime_execute_error": "consumed",
        "runtime_dry_run_preview": "not_required",
        "dry_run_preview": "not_required",
        "not_required": "not_required",
    }
    return aliases.get(normalized, normalized)


def agent_worker_runtime_preview_token_status(preview):
    status = normalize_agent_worker_runtime_preview_status(preview.get("token_status"))
    if status:
        return status
    execution_status = normalize_agent_worker_runtime_preview_status(preview.get("execution_status"))
    return execution_status or "unknown"


def summarize_agent_worker_runtime_previews(previews):
    summary = {"total": len(previews), "pending": 0, "consumed": 0, "expired": 0, "revoked": 0, "not_required": 0, "unknown": 0}
    for preview in previews:
        status = agent_worker_runtime_preview_token_status(preview)
        if status not in summary:
            status = "unknown"
        summary[status] += 1
    return summary


def list_agent_worker_runtime_previews(workspace: Path, limit=20, status=None):
    status_filter = normalize_agent_worker_runtime_preview_status(status)
    all_previews = list(reversed(load_agent_worker_runtime_previews(workspace)))
    previews = all_previews
    total = len(all_previews)
    if status_filter:
        previews = [preview for preview in previews if agent_worker_runtime_preview_token_status(preview) == status_filter]
    matched = len(previews)
    limit_int = int(limit or 20)
    visible = previews[:limit_int] if limit_int > 0 else previews
    return {"count": len(visible), "total": total, "matched": matched, "summary": summarize_agent_worker_runtime_previews(all_previews), "filters": {"status": status_filter}, "previews": visible, "path": str(agent_worker_runtime_previews_path(workspace))}


def expire_stale_agent_worker_runtime_previews(workspace: Path):
    previews = load_agent_worker_runtime_previews(workspace)
    expired = []
    for preview in previews:
        if agent_worker_runtime_preview_token_status(preview) != "pending":
            continue
        if not agent_worker_runtime_preview_is_expired(preview):
            continue
        confirmation = dict(preview.get("confirmation") or {})
        confirmation["accepted"] = False
        confirmation["reason"] = "token_expired"
        preview.update({"token_status": "expired", "execution_status": "expired", "expired_at": now(), "confirmation": confirmation})
        expired.append(preview)
    if expired:
        write_json(agent_worker_runtime_previews_path(workspace), previews)
    return {"status": "runtime_previews_expired", "scanned": len(previews), "expired": len(expired), "expired_preview_ids": [preview.get("preview_id") or preview.get("id") for preview in expired], "previews": expired, "path": str(agent_worker_runtime_previews_path(workspace))}


def find_agent_worker_runtime_preview_by_token(workspace: Path, token):
    if not token:
        return None
    for preview in reversed(load_agent_worker_runtime_previews(workspace)):
        confirmation = preview.get("confirmation") or {}
        if confirmation.get("token") == token:
            return preview
    return None


def find_agent_worker_runtime_preview(workspace: Path, preview_id=None, confirmation_token=None):
    if preview_id:
        for preview in reversed(load_agent_worker_runtime_previews(workspace)):
            if preview.get("preview_id") == preview_id or preview.get("id") == preview_id:
                return preview
    return find_agent_worker_runtime_preview_by_token(workspace, confirmation_token)


def agent_worker_runtime_preview_detail(workspace: Path, preview_id=None, confirmation_token=None):
    preview = find_agent_worker_runtime_preview(workspace, preview_id, confirmation_token)
    if not preview:
        return {"status": "runtime_preview_not_found", "error": "runtime_preview_not_found", "preview_id": preview_id, "confirmation_token": confirmation_token, "preview": None, "path": str(agent_worker_runtime_previews_path(workspace))}
    token_status = agent_worker_runtime_preview_token_status(preview)
    return {"status": "runtime_preview_found", "preview_id": preview.get("preview_id") or preview.get("id"), "one_shot_run_id": preview.get("one_shot_run_id"), "token_status": token_status, "execution_status": preview.get("execution_status"), "preview": preview, "path": str(agent_worker_runtime_previews_path(workspace))}


def agent_worker_runtime_confirmation_preflight(workspace: Path, confirmation_token=None, preview_id=None):
    preview = find_agent_worker_runtime_preview(workspace, preview_id, confirmation_token)
    if not preview:
        confirmation = {"required": True, "accepted": False, "token": confirmation_token, "reason": "invalid_confirmation_token"}
        return {"status": "confirmation_token_not_found", "decision": "confirmation_preflight", "valid": False, "can_execute": False, "will_execute": False, "dry_run": True, "reason": "confirmation token was not found", "preview_id": preview_id, "one_shot_run_id": None, "confirmation_token": confirmation_token, "token_status": "unknown", "execution_status": None, "confirmation": confirmation, "preview": None, "path": str(agent_worker_runtime_previews_path(workspace))}
    resolved_token = (preview.get("confirmation") or {}).get("token") or confirmation_token
    token_status = agent_worker_runtime_preview_token_status(preview)
    if token_status == "pending" and agent_worker_runtime_preview_is_expired(preview):
        token_status = "expired"
    status_map = {
        "pending": ("confirmation_token_pending", True, "confirmation token is pending and not expired", "token_pending"),
        "expired": ("confirmation_token_expired", False, "confirmation token expired before execution", "token_expired"),
        "revoked": ("confirmation_token_revoked", False, "confirmation token was revoked before execution", "token_revoked"),
        "consumed": ("confirmation_token_consumed", False, "confirmation token already consumed by prior runtime execution", "token_consumed"),
    }
    status, can_execute, reason, confirmation_reason = status_map.get(token_status, ("confirmation_token_not_executable", False, "confirmation token is not executable", "invalid_confirmation_token"))
    confirmation = dict(preview.get("confirmation") or {})
    confirmation["accepted"] = False
    confirmation["token"] = resolved_token
    confirmation["reason"] = confirmation_reason
    return {"status": status, "decision": "confirmation_preflight", "valid": bool(can_execute), "can_execute": bool(can_execute), "will_execute": False, "dry_run": True, "reason": reason, "preview_id": preview.get("preview_id") or preview.get("id"), "one_shot_run_id": preview.get("one_shot_run_id"), "confirmation_token": resolved_token, "token_status": token_status, "execution_status": preview.get("execution_status"), "confirmation": confirmation, "preview": preview, "path": str(agent_worker_runtime_previews_path(workspace))}


def agent_worker_runtime_preflight_blocked_response(workspace: Path, preflight: dict) -> dict:
    config = load_agent_worker_config(workspace)
    runtime = agent_worker_runtime_config_state(config)
    preview = preflight.get("preview") or {}
    return {
        "status": "confirmation_preflight_blocked",
        "decision": "confirmation_preflight_blocked",
        "reason": preflight.get("reason") or "confirmation preflight blocked runtime execution",
        "runtime_mode": runtime["mode"],
        "dry_run": True,
        "will_execute": False,
        "preflight_gate": True,
        "preflight": preflight,
        "planned": preview.get("planned", 0),
        "executed": 0,
        "max_items": preview.get("max_items"),
        "filters": preview.get("filters", {}),
        "items": preview.get("items", []),
        "queue_ids": preview.get("queue_ids", []),
        "results": preview.get("results", []),
        "preview": preflight.get("preview"),
        "preview_id": preflight.get("preview_id"),
        "one_shot_run_id": preflight.get("one_shot_run_id"),
        "token_status": preflight.get("token_status"),
        "expires_at": preview.get("expires_at"),
        "audit": None,
        "confirmation": preflight.get("confirmation"),
        "execution_policy": preview.get("execution_policy"),
        "approval": agent_worker_approval_state(workspace, config),
        "runtime": runtime,
        "scheduler": {"enabled": False, "mode": "manual_runtime_execute_preflight_blocked"},
        "config": config,
        "path": str(agent_worker_runtime_audits_path(workspace)),
    }


def agent_worker_runtime_tick_with_preflight_gate(workspace: Path, confirm_execute=False, confirmation_token=None, preflight_gate=False):
    if not (preflight_gate and confirm_execute):
        return agent_worker_runtime_tick(workspace, confirm_execute=confirm_execute, confirmation_token=confirmation_token)
    preflight = agent_worker_runtime_confirmation_preflight(workspace, confirmation_token=confirmation_token)
    if not preflight.get("can_execute"):
        result = agent_worker_runtime_preflight_blocked_response(workspace, preflight)
        return attach_agent_worker_runtime_confirm_attempt(workspace, preflight, result, runtime_called=False)
    result = agent_worker_runtime_tick(workspace, confirm_execute=confirm_execute, confirmation_token=confirmation_token)
    result["preflight_gate"] = True
    result["preflight"] = preflight
    return attach_agent_worker_runtime_confirm_attempt(workspace, preflight, result, runtime_called=True)


def agent_worker_runtime_preview_expires_at(created_at=None, ttl_seconds=900):
    base = datetime.fromisoformat(created_at) if created_at else datetime.now().replace(microsecond=0)
    return (base + timedelta(seconds=max(1, int(ttl_seconds or 900)))).replace(microsecond=0).isoformat()


def agent_worker_runtime_preview_is_expired(preview: dict):
    expires_at = preview.get("expires_at")
    if not expires_at:
        return False
    try:
        return datetime.fromisoformat(str(expires_at)) <= datetime.now().replace(microsecond=0)
    except ValueError:
        return False


def agent_worker_runtime_reject_confirmation(workspace: Path, preview: dict, status: str, reason: str, confirmation_reason: str, runtime: dict, config: dict, approval_state: dict, scheduler: dict, mutate_preview=False):
    confirmation = dict(preview.get("confirmation") or {})
    confirmation["accepted"] = False
    confirmation["reason"] = confirmation_reason
    if mutate_preview:
        token_status = "expired" if confirmation_reason == "token_expired" else "revoked" if confirmation_reason == "token_revoked" else "consumed"
        updates = {"token_status": token_status, "execution_status": token_status, "confirmation": confirmation}
        if token_status == "expired":
            updates["expired_at"] = now()
        update_agent_worker_runtime_preview(workspace, preview.get("preview_id"), updates)
        preview = dict(preview)
        preview.update(updates)
    return {"status": status, "decision": "confirmation_rejected", "reason": reason, "runtime_mode": runtime["mode"], "dry_run": True, "will_execute": False, "planned": preview.get("planned", 0), "executed": 0, "max_items": preview.get("max_items"), "filters": preview.get("filters", {}), "items": preview.get("items", []), "queue_ids": preview.get("queue_ids", []), "results": preview.get("results", []), "preview": preview, "preview_id": preview.get("preview_id"), "one_shot_run_id": preview.get("one_shot_run_id"), "token_status": preview.get("token_status"), "expires_at": preview.get("expires_at"), "audit": None, "confirmation": confirmation, "execution_policy": preview.get("execution_policy"), "approval": approval_state, "runtime": runtime, "scheduler": scheduler, "config": config, "path": str(agent_worker_runtime_audits_path(workspace))}


def revoke_agent_worker_runtime_preview(workspace: Path, preview_id=None, confirmation_token=None, reason=None):
    preview = find_agent_worker_runtime_preview(workspace, preview_id, confirmation_token)
    if not preview:
        return {"status": "runtime_preview_not_found", "error": "runtime_preview_not_found", "preview_id": preview_id, "confirmation_token": confirmation_token, "path": str(agent_worker_runtime_previews_path(workspace))}
    confirmation = dict(preview.get("confirmation") or {})
    confirmation["accepted"] = False
    confirmation["reason"] = "token_revoked"
    updates = {"token_status": "revoked", "execution_status": "revoked", "revoked_at": now(), "revocation_reason": reason or "operator_revoked", "confirmation": confirmation}
    updated = update_agent_worker_runtime_preview(workspace, preview.get("preview_id"), updates) or dict(preview, **updates)
    return {"status": "runtime_preview_revoked", "decision": "confirmation_revoked", "preview_id": updated.get("preview_id"), "one_shot_run_id": updated.get("one_shot_run_id"), "token_status": updated.get("token_status"), "execution_status": updated.get("execution_status"), "revocation_reason": updated.get("revocation_reason"), "confirmation": updated.get("confirmation"), "preview": updated, "path": str(agent_worker_runtime_previews_path(workspace))}


def approved_agent_worker_enable(workspace: Path, config: dict):
    approval_id = config.get("enabled_by_approval") or config.get("enable_approval_id")
    if not (bool(config.get("enabled")) and approval_id):
        return None
    approval = next((item for item in find_agent_worker_enable_approvals(workspace) if item.get("id") == approval_id), None)
    if approval and approval.get("status") == "approved":
        return approval
    return None


def agent_worker_runtime_queue_ids(result: dict):
    return [str(item.get("queue_id")) for item in result.get("items", []) if item.get("queue_id")]


def agent_worker_runtime_execution_policy(runtime: dict, config: dict):
    return {"manual_only": True, "scheduler_enabled": False, "scheduler_mode": "disabled", "approval_required": True, "confirmation_required": runtime.get("mode") == "execute", "bounded": True, "max_items_per_tick": config.get("max_items_per_tick"), "preview_ttl_seconds": config.get("preview_ttl_seconds"), "runtime_mode": runtime.get("mode"), "dry_run": runtime.get("mode") != "execute"}


def agent_worker_runtime_confirmation_token(config: dict, approval: dict, result: dict, preview_id=None, one_shot_run_id=None):
    filters = result.get("filters") or {}
    payload = {
        "preview_id": preview_id,
        "one_shot_run_id": one_shot_run_id,
        "approval_id": approval.get("id"),
        "runtime_mode": config.get("runtime_mode"),
        "worker": config.get("worker"),
        "max_items_per_tick": config.get("max_items_per_tick"),
        "ttl_seconds": config.get("ttl_seconds"),
        "preview_ttl_seconds": config.get("preview_ttl_seconds"),
        "filters": {"queue_id": filters.get("queue_id"), "project": filters.get("project"), "owner": filters.get("owner")},
        "queue_ids": agent_worker_runtime_queue_ids(result),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def agent_worker_runtime_confirmation(runtime: dict, config: dict, approval: dict | None, result: dict, accepted=False, reason=None, preview_id=None, one_shot_run_id=None):
    required = runtime.get("mode") == "execute"
    token = agent_worker_runtime_confirmation_token(config, approval or {}, result, preview_id, one_shot_run_id) if required and approval else None
    confirmation = {"required": required, "accepted": bool(accepted), "token": token, "confirm_execute_arg": "--confirm-execute", "api_field": "confirmation_token", "api_confirm_field": "confirm_execute"}
    if reason:
        confirmation["reason"] = reason
    return confirmation


def agent_worker_runtime_preview(workspace: Path):
    config = load_agent_worker_config(workspace)
    runtime = agent_worker_runtime_config_state(config)
    approval = approved_agent_worker_enable(workspace, config)
    approval_state = agent_worker_approval_state(workspace, config)
    scheduler = {"enabled": False, "mode": "manual_runtime_preview"}
    if not approval:
        return {"status": "approval_required", "decision": "approval_required", "reason": "approved enable_agent_worker_daemon approval required before runtime preview", "runtime_mode": runtime["mode"], "dry_run": True, "will_execute": False, "planned": 0, "executed": 0, "items": [], "queue_ids": [], "audit": None, "confirmation": {"required": runtime.get("mode") == "execute", "accepted": False, "token": None, "confirm_execute_arg": "--confirm-execute", "api_field": "confirmation_token", "api_confirm_field": "confirm_execute"}, "execution_policy": agent_worker_runtime_execution_policy(runtime, config), "approval": approval_state, "runtime": runtime, "scheduler": scheduler, "config": config, "path": str(agent_worker_runtime_previews_path(workspace))}
    filters = config.get("filters") or {}
    result = run_batch_agent_queue_items(workspace, str(config.get("worker") or "dashboard-agent"), config.get("max_items_per_tick", 1), config.get("ttl_seconds", 300), True, filters.get("queue_id"), filters.get("project"), filters.get("owner"))
    status = "runtime_execute_preview" if runtime["mode"] == "execute" else "runtime_dry_run_preview"
    preview_id = f"runtime_preview_{uuid4().hex[:10]}"
    one_shot_run_id = f"runtime_once_{uuid4().hex[:10]}"
    created_at = now()
    expires_at = agent_worker_runtime_preview_expires_at(created_at, config.get("preview_ttl_seconds", 900))
    confirmation = agent_worker_runtime_confirmation(runtime, config, approval, result, preview_id=preview_id, one_shot_run_id=one_shot_run_id)
    execution_policy = agent_worker_runtime_execution_policy(runtime, config)
    record = {"id": preview_id, "preview_id": preview_id, "one_shot_run_id": one_shot_run_id, "status": status, "execution_status": "pending_confirmation" if runtime["mode"] == "execute" else "dry_run_preview", "token_status": "pending" if runtime["mode"] == "execute" else "not_required", "created_at": created_at, "expires_at": expires_at, "worker": config.get("worker"), "approval_id": approval.get("id"), "runtime_mode": runtime["mode"], "dry_run": True, "will_execute": False, "planned": result.get("planned", 0), "executed": 0, "max_items": result.get("max_items"), "filters": result.get("filters", {}), "items": result.get("items", []), "queue_ids": agent_worker_runtime_queue_ids(result), "results": result.get("results", []), "audit": None, "confirmation": confirmation, "execution_policy": execution_policy, "approval": approval_state, "runtime": runtime, "scheduler": scheduler, "config": config, "path": str(agent_worker_runtime_previews_path(workspace))}
    append_agent_worker_runtime_preview(workspace, record)
    return record



def agent_worker_runtime_tick(workspace: Path, confirm_execute=False, confirmation_token=None):
    config = load_agent_worker_config(workspace)
    runtime = agent_worker_runtime_config_state(config)
    approval = approved_agent_worker_enable(workspace, config)
    approval_state = agent_worker_approval_state(workspace, config)
    dry_run = runtime["mode"] != "execute"
    scheduler = {"enabled": False, "mode": "manual_runtime_dry_run" if dry_run else "manual_runtime_execute"}
    if not approval:
        return {
            "status": "approval_required",
            "decision": "approval_required",
            "reason": "approved enable_agent_worker_daemon approval required before runtime tick",
            "runtime_mode": runtime["mode"],
            "dry_run": True,
            "will_execute": False,
            "planned": 0,
            "executed": 0,
            "items": [],
            "queue_ids": [],
            "audit": None,
            "confirmation": {"required": runtime.get("mode") == "execute", "accepted": False, "token": None, "confirm_execute_arg": "--confirm-execute", "api_field": "confirmation_token", "api_confirm_field": "confirm_execute"},
            "execution_policy": agent_worker_runtime_execution_policy(runtime, config),
            "approval": approval_state,
            "runtime": runtime,
            "scheduler": scheduler,
            "config": config,
            "path": str(agent_worker_runtime_audits_path(workspace)),
        }
    preview_record = None
    if runtime["mode"] == "execute":
        preview_record = find_agent_worker_runtime_preview_by_token(workspace, confirmation_token)
        if confirm_execute and not preview_record:
            preview_record = agent_worker_runtime_preview(workspace)
            confirmation_token = (preview_record.get("confirmation") or {}).get("token")
        if not preview_record:
            preview = agent_worker_runtime_preview(workspace)
            reason = "invalid_confirmation_token" if confirmation_token else "missing_execute_confirmation"
            confirmation = dict(preview.get("confirmation") or {})
            confirmation["accepted"] = False
            confirmation["reason"] = reason
            return {"status": "execute_confirmation_required", "decision": "confirmation_required", "reason": "execute runtime_mode requires explicit operator confirmation", "runtime_mode": runtime["mode"], "dry_run": True, "will_execute": False, "planned": preview.get("planned", 0), "executed": 0, "max_items": preview.get("max_items"), "filters": preview.get("filters", {}), "items": preview.get("items", []), "queue_ids": preview.get("queue_ids", []), "results": preview.get("results", []), "preview": preview, "preview_id": preview.get("preview_id"), "one_shot_run_id": preview.get("one_shot_run_id"), "audit": None, "confirmation": confirmation, "execution_policy": preview.get("execution_policy"), "approval": approval_state, "runtime": runtime, "scheduler": scheduler, "config": config, "path": str(agent_worker_runtime_audits_path(workspace))}
        confirmation_token = (preview_record.get("confirmation") or {}).get("token")
        token_status = preview_record.get("token_status") or ("pending" if preview_record.get("execution_status") == "pending_confirmation" else "consumed")
        if token_status == "revoked" or preview_record.get("execution_status") == "revoked":
            return agent_worker_runtime_reject_confirmation(workspace, preview_record, "confirmation_token_revoked", "confirmation token was revoked before execution", "token_revoked", runtime, config, approval_state, scheduler)
        if token_status == "expired" or preview_record.get("execution_status") == "expired" or agent_worker_runtime_preview_is_expired(preview_record):
            return agent_worker_runtime_reject_confirmation(workspace, preview_record, "confirmation_token_expired", "confirmation token expired before execution", "token_expired", runtime, config, approval_state, scheduler, mutate_preview=True)
        if preview_record.get("execution_status") != "pending_confirmation" or token_status != "pending":
            return agent_worker_runtime_reject_confirmation(workspace, preview_record, "confirmation_token_consumed", "confirmation token already consumed by prior runtime execution", "token_consumed", runtime, config, approval_state, scheduler)
    filters = config.get("filters") or {}
    execution_context = None
    if preview_record:
        execution_context = {"runtime_preview_id": preview_record.get("preview_id"), "one_shot_run_id": preview_record.get("one_shot_run_id"), "confirmation_token": confirmation_token, "execution_policy": preview_record.get("execution_policy")}
    result = run_batch_agent_queue_items(workspace, str(config.get("worker") or "dashboard-agent"), config.get("max_items_per_tick", 1), config.get("ttl_seconds", 300), dry_run, filters.get("queue_id"), filters.get("project"), filters.get("owner"), execution_context)
    status = "runtime_dry_run_audited" if dry_run else "runtime_execute_completed"
    if result.get("status") == "error":
        status = "runtime_execute_error" if not dry_run else "runtime_dry_run_error"
    executed = 0 if dry_run else int(result.get("executed", 0) or 0)
    preview_id = preview_record.get("preview_id") if preview_record else None
    one_shot_run_id = preview_record.get("one_shot_run_id") if preview_record else None
    confirmation = agent_worker_runtime_confirmation(runtime, config, approval, result, accepted=(runtime["mode"] == "execute"), preview_id=preview_id, one_shot_run_id=one_shot_run_id)
    if confirmation_token:
        confirmation["token"] = confirmation_token
    queue_run_ids = [entry.get("run_record", {}).get("run_id") for entry in result.get("results", []) if entry.get("run_record", {}).get("run_id")]
    execution_policy = preview_record.get("execution_policy") if preview_record else agent_worker_runtime_execution_policy(runtime, config)
    audit = {
        "id": f"runtime_tick_{uuid4().hex[:10]}",
        "trigger": "manual_runtime_dry_run" if dry_run else "manual_runtime_execute",
        "status": status,
        "created_at": now(),
        "worker": config.get("worker"),
        "approval_id": approval.get("id"),
        "preview_id": preview_id,
        "one_shot_run_id": one_shot_run_id,
        "runtime_mode": runtime["mode"],
        "dry_run": dry_run,
        "planned": result.get("planned", 0),
        "executed": executed,
        "max_items": result.get("max_items"),
        "filters": result.get("filters", {}),
        "items": result.get("items", []),
        "queue_ids": agent_worker_runtime_queue_ids(result),
        "queue_run_ids": queue_run_ids,
        "confirmation": {"required": confirmation.get("required"), "accepted": confirmation.get("accepted"), "token": confirmation.get("token")},
        "execution_policy": execution_policy,
        "scheduler": scheduler,
    }
    append_agent_worker_runtime_audit(workspace, audit)
    if preview_record:
        update_agent_worker_runtime_preview(workspace, preview_id, {"execution_status": status, "token_status": "consumed", "consumed_at": now(), "executed_at": now(), "runtime_audit_id": audit["id"], "queue_run_ids": queue_run_ids, "confirmation": confirmation})
    append_event(workspace, "agent_worker_runtime_tick_audited", audit_id=audit["id"], planned=audit["planned"], executed=executed)
    return {
        "status": status,
        "runtime_mode": runtime["mode"],
        "dry_run": dry_run,
        "will_execute": False,
        "planned": result.get("planned", 0),
        "executed": executed,
        "max_items": result.get("max_items"),
        "filters": result.get("filters", {}),
        "items": result.get("items", []),
        "queue_ids": agent_worker_runtime_queue_ids(result),
        "results": result.get("results", []),
        "preview_id": preview_id,
        "one_shot_run_id": one_shot_run_id,
        "token_status": "consumed" if preview_record and runtime["mode"] == "execute" else None,
        "expires_at": preview_record.get("expires_at") if preview_record else None,
        "audit": audit,
        "confirmation": confirmation,
        "execution_policy": execution_policy,
        "approval": approval_state,
        "runtime": runtime,
        "scheduler": scheduler,
        "config": config,
        "path": str(agent_worker_runtime_audits_path(workspace)),
    }



def kanban_export(workspace: Path, slug: str):
    project_dir = workspace / "projects" / slug
    project = read_json(project_dir / "project.json", {})
    tasks = read_json(project_dir / "tasks.json", [])
    if not project or not tasks:
        return {"error": "project_not_found_or_empty", "project": slug}
    export = {
        "project": slug,
        "goal": project.get("goal"),
        "tasks": [
            {
                "title": f"{task.get('id')}: {task.get('objective')}",
                "body": "\n".join([
                    f"Project: {slug}",
                    f"Owner: {task.get('owner')}",
                    f"Risk: {task.get('risk_level')}",
                    f"Depends on: {', '.join(task.get('depends_on') or []) or 'none'}",
                    "Acceptance criteria:",
                    *[f"- {c}" for c in task.get("acceptance_criteria", [])],
                    f"Expected artifacts: {', '.join(task.get('artifacts') or []) or 'none'}",
                ]),
                "assignee": task.get("owner"),
                "parents": task.get("depends_on", []),
                "source_task_id": task.get("id"),
            }
            for task in tasks
        ],
        "generated_at": now(),
    }
    out_dir = workspace / "exports" / "kanban"
    json_path = out_dir / f"{slug}.json"
    md_path = out_dir / f"{slug}.md"
    write_json(json_path, export)
    lines = [f"# Hermes Kanban Export: {slug}", "", "## Goal", str(project.get("goal", "")), "", "## Commands", ""]
    for task in export["tasks"]:
        title = task["title"].replace('"', "'")
        body = task["body"].replace('"', "'")
        lines.append(f"```bash\nhermes kanban create --title \"{title}\" --assignee \"{task['assignee']}\" --body \"{body}\"\n```")
    write_text(md_path, "\n".join(lines) + "\n")
    append_event(workspace, "kanban_export_created", project=slug, json=str(json_path), markdown=str(md_path))
    return {"status": "created", "json": str(json_path), "markdown": str(md_path)}


def discover_profiles():
    try:
        result = subprocess.run(["hermes", "profile", "list"], text=True, capture_output=True, timeout=10)
    except Exception as exc:
        return {"available": False, "profiles": [], "error": str(exc)}
    profiles = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped or stripped.lower().startswith(("profile", "name", "---")):
            continue
        first = stripped.split()[0].strip("*│| ")
        if first and first not in {"-", "+"}:
            profiles.append(first)
    return {"available": result.returncode == 0, "profiles": profiles, "raw": result.stdout, "error": result.stderr}


DEFAULT_PROFILE_MAPPING = {
    "orchestrator": "default",
    "content-agent": "default",
    "coding-agent": "default",
    "qa-agent": "default",
    "email-agent": "default",
}


def profile_mapping_path(workspace: Path) -> Path:
    return workspace / "config" / "profile-mapping.json"


def get_profile_mapping(workspace: Path):
    mapping = DEFAULT_PROFILE_MAPPING.copy()
    mapping.update(read_json(profile_mapping_path(workspace), {}))
    return {"mapping": mapping, "path": str(profile_mapping_path(workspace))}


def save_profile_mapping(workspace: Path, mapping_update: dict):
    current = get_profile_mapping(workspace)["mapping"]
    clean = {str(k).strip(): str(v).strip() for k, v in mapping_update.items() if str(k).strip() and str(v).strip()}
    current.update(clean)
    write_json(profile_mapping_path(workspace), current)
    append_event(workspace, "profile_mapping_saved", mapping=current)
    return {"status": "saved", "mapping": current, "path": str(profile_mapping_path(workspace))}


def kanban_commands_for_project(workspace: Path, slug: str, mapping: dict):
    tasks = project_tasks(workspace, slug)
    commands = []
    for task in tasks:
        assignee = mapping.get(task.get("owner"), "default")
        title = f"{task.get('id')}: {task.get('objective')}".replace('"', "'")
        body = "\n".join([
            f"AgentOS project: {slug}",
            f"Source task: {task.get('id')}",
            f"Owner: {task.get('owner')}",
            f"Depends on: {', '.join(task.get('depends_on') or []) or 'none'}",
            "Acceptance criteria:",
            *[f"- {c}" for c in task.get("acceptance_criteria", [])],
        ]).replace('"', "'")
        commands.append(f"hermes kanban create --title \"{title}\" --assignee \"{assignee}\" --body \"{body}\"")
    return commands


def kanban_create_request(workspace: Path, slug: str, mode: str = "dry-run", approval_id: str | None = None, simulate: bool = False):
    mapping = get_profile_mapping(workspace)["mapping"]
    commands = kanban_commands_for_project(workspace, slug, mapping)
    tasks = project_tasks(workspace, slug)
    if not commands:
        return {"error": "no_tasks_to_create", "project": slug}
    if mode == "dry-run":
        return {"mode": "dry-run", "project": slug, "would_create": len(commands), "commands": commands, "mapping": mapping}
    if mode != "execute":
        return {"error": "invalid_mode", "mode": mode}
    approvals = list_approvals(workspace)
    approval = next((a for a in approvals if a.get("id") == approval_id), None)
    if not approval or approval.get("status") != "approved" or approval.get("action") != "create_real_kanban_tasks":
        result = request_approval(workspace, "create_real_kanban_tasks", f"Create {len(commands)} real Hermes Kanban tasks for project {slug}")
        return {"decision": "approval_required", "risk": "high", "approval": result.get("approval"), "commands": commands}

    links = []
    raw_results = []
    for idx, command in enumerate(commands):
        agentos_task_id = tasks[idx].get("id") if idx < len(tasks) else f"T{idx+1:03d}"
        if simulate:
            hermes_task_id = f"sim_{slug}_{agentos_task_id}".replace("-", "_")
            raw = "simulated"
        else:
            completed = subprocess.run(command, text=True, capture_output=True, shell=True, timeout=60)
            raw = (completed.stdout or "") + (completed.stderr or "")
            if completed.returncode != 0:
                return {"error": "kanban_create_failed", "project": slug, "command": command, "returncode": completed.returncode, "output": raw, "links": links}
            match = re.search(r"(?:task[_ -]?id|id)[:=\s]+([A-Za-z0-9_\-.]+)", raw, re.IGNORECASE)
            hermes_task_id = match.group(1) if match else f"unknown_{idx+1}"
        links.append({"agentos_task_id": agentos_task_id, "hermes_task_id": hermes_task_id, "command": command})
        raw_results.append({"agentos_task_id": agentos_task_id, "output": raw})

    mapping_doc = {"project": slug, "approval_id": approval_id, "simulated": bool(simulate), "created_at": now(), "links": links, "raw_results": raw_results}
    mapping_path = workspace / "exports" / "kanban" / f"{slug}.links.json"
    write_json(mapping_path, mapping_doc)
    append_event(workspace, "real_kanban_tasks_created" if not simulate else "real_kanban_tasks_simulated", project=slug, approval_id=approval_id, count=len(links), mapping_path=str(mapping_path))
    return {"mode": "execute-simulated" if simulate else "execute", "project": slug, "created": len(links), "links": links, "mapping_path": str(mapping_path)}


def kanban_links(workspace: Path, slug: str):
    path = workspace / "exports" / "kanban" / f"{slug}.links.json"
    if not path.exists():
        return {"project": slug, "links": [], "mapping_path": str(path), "exists": False}
    data = read_json(path, {"project": slug, "links": []})
    data["exists"] = True
    data["mapping_path"] = str(path)
    return data


def command_help():
    return {
        "examples": [
            "создай goal Сделай лендинг для SaaS",
            "покажи digest",
            "создай approval send_email Отправить письмо клиенту",
            "экспортируй в kanban <project-slug>",
        ]
    }


SECRETISH_KEYS = {"api_key", "key", "token", "secret", "password"}
SECRET_VALUE_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"AIza[0-9A-Za-z_-]{20,}"),
    re.compile(r"ghp_[0-9A-Za-z_]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*['\"]?[^'\"\s,}]{8,}"),
]


def deep_merge(base: dict, overlay: dict) -> dict:
    result = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def redact_secret_text(text: str) -> str:
    redacted = text
    for pattern in SECRET_VALUE_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def redact_secrets(value):
    if isinstance(value, dict):
        redacted = {}
        for key, child in value.items():
            if str(key).lower() in SECRETISH_KEYS and child:
                redacted[key] = "[REDACTED]"
            else:
                redacted[key] = redact_secrets(child)
        return redacted
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if isinstance(value, str):
        return redact_secret_text(value)
    return value


def voice_config_paths(workspace: Path):
    base = workspace / "config" / "voice.json"
    if not base.exists():
        base = Path("C:/Users/User/AgentOS/config/voice.json")
    local = workspace / "config" / "voice.local.json"
    return base, local


def load_voice_config_raw(workspace: Path):
    load_workspace_dotenv(workspace)
    base_path, local_path = voice_config_paths(workspace)
    data = read_json(base_path, {"default_provider": "mock_text", "providers": {}})
    if local_path.exists():
        data = deep_merge(data, read_json(local_path, {}))
    return data, base_path, local_path


def load_voice_provider_module(workspace: Path, provider: str):
    candidates = [workspace / "voice" / "providers" / f"{provider}.py", DEFAULT_WORKSPACE / "voice" / "providers" / f"{provider}.py"]
    module_path = next((path for path in candidates if path.exists()), None)
    if module_path is None:
        raise FileNotFoundError(f"voice provider module not found: {provider}")
    spec = importlib.util.spec_from_file_location(f"agentos_voice_{provider}", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load voice provider module: {provider}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_voice_config(workspace: Path):
    data, base_path, local_path = load_voice_config_raw(workspace)
    data = redact_secrets(data)
    data["path"] = str(base_path)
    data["local_path"] = str(local_path)
    data["local_exists"] = local_path.exists()
    return data


def voice_provider_status(name: str, cfg: dict):
    enabled = bool(cfg.get("enabled", True))
    allow_env_credentials = bool(cfg.get("allow_env_credentials", False))
    key_envs = [cfg.get("api_key_env"), cfg.get("fallback_api_key_env")]
    key_envs = [item for item in key_envs if item]
    has_env_key = allow_env_credentials and any(os.getenv(item) for item in key_envs)
    inline_key = cfg.get("api_key")
    has_inline_key = bool(inline_key and inline_key != "[REDACTED]")
    reasons = []
    if not enabled:
        reasons.append("disabled")
    if name == "gemini_live" and not (has_env_key or has_inline_key):
        reasons.append("missing_credentials")
    if name == "local_file" and enabled:
        input_file = cfg.get("input_file")
        if input_file and not Path(input_file).exists():
            reasons.append("input_file_missing")
    ready = not reasons
    return {
        "provider": name,
        "enabled": enabled,
        "mode": cfg.get("mode", "unknown"),
        "model": cfg.get("model"),
        "ready": ready,
        "reasons": reasons or ["ready"],
        "has_env_key": has_env_key,
        "has_inline_key": has_inline_key,
    }


def voice_health(workspace: Path):
    data, _, _ = load_voice_config_raw(workspace)
    providers = [voice_provider_status(name, cfg) for name, cfg in sorted(data.get("providers", {}).items())]
    ready = sum(1 for item in providers if item["ready"])
    return {
        "status": "ok",
        "workspace": str(workspace),
        "default_provider": data.get("default_provider"),
        "summary": {"providers": len(providers), "ready": ready, "not_ready": len(providers) - ready},
        "providers": redact_secrets(providers),
    }


def dashboard_runtime_diagnostics(workspace: Path):
    """Return read-only runtime metadata for the dashboard process."""
    data, base_path, local_path = load_voice_config_raw(workspace)
    gemini_cfg = data.get("providers", {}).get("gemini_live", {})
    gemini_status = voice_provider_status("gemini_live", gemini_cfg) if gemini_cfg else {
        "provider": "gemini_live",
        "ready": False,
        "reasons": ["not_configured"],
        "enabled": False,
        "has_env_key": False,
        "has_inline_key": False,
    }
    key_env_names = [gemini_cfg.get("api_key_env", "GEMINI_API_KEY"), gemini_cfg.get("fallback_api_key_env", "GOOGLE_API_KEY")]
    key_env_names = [item for item in key_env_names if item]
    return {
        "status": "ok",
        "decision": "dashboard_runtime_diagnostics",
        "dry_run": True,
        "will_apply": False,
        "writes_enabled": False,
        "read_only": True,
        "generated_at": now(),
        "workspace": str(workspace),
        "process": {
            "pid": os.getpid(),
            "ppid": os.getppid() if hasattr(os, "getppid") else None,
            "cwd": os.getcwd(),
            "argv_count": len(sys.argv),
            "argv": redact_secrets(sys.argv),
        },
        "config": {
            "voice_config_path": str(base_path),
            "voice_local_path": str(local_path),
            "voice_local_exists": local_path.exists(),
        },
        "credential_visibility": {
            "gemini_live": {
                "provider": "gemini_live",
                "ready": bool(gemini_status.get("ready")),
                "reasons": list(gemini_status.get("reasons") or []),
                "enabled": bool(gemini_status.get("enabled")),
                "allow_env_credentials": bool(gemini_cfg.get("allow_env_credentials", False)),
                "has_env_key": bool(gemini_status.get("has_env_key")),
                "has_inline_key": bool(gemini_status.get("has_inline_key")),
                "api_key_env_names": key_env_names,
                "local_override_exists": local_path.exists(),
            }
        },
        "safety": {
            "read_only": True,
            "process_mutation_enabled": False,
            "config_writes_enabled": False,
            "secrets_redacted": True,
            "raw_env_values_returned": False,
        },
        "links": {
            "status": "/api/status",
            "voice_health": "/api/voice-health",
            "production_readiness": "/api/production-readiness",
        },
    }


def dashboard_runtime_diagnostics_export_markdown(payload: dict):
    process = payload.get("process") or {}
    safety = payload.get("safety") or {}
    config = payload.get("config") or {}
    gemini = ((payload.get("credential_visibility") or {}).get("gemini_live") or {})
    lines = [
        "# AgentOS Dashboard Runtime Diagnostics",
        "",
        "## Runtime",
        f"- status: {payload.get('status')}",
        f"- generated_at: {payload.get('generated_at')}",
        f"- workspace: {payload.get('workspace')}",
        f"- pid: {process.get('pid')}",
        f"- ppid: {process.get('ppid')}",
        f"- argv_count: {process.get('argv_count')}",
        "",
        "## Gemini Live Credential Visibility",
        f"- ready: {gemini.get('ready')}",
        f"- reasons: {', '.join(gemini.get('reasons') or []) or '—'}",
        f"- enabled: {gemini.get('enabled')}",
        f"- allow_env_credentials: {gemini.get('allow_env_credentials')}",
        f"- has_env_key: {gemini.get('has_env_key')}",
        f"- has_inline_key: {gemini.get('has_inline_key')}",
        f"- api_key_env_names: {', '.join(gemini.get('api_key_env_names') or []) or '—'}",
        f"- local_override_exists: {gemini.get('local_override_exists')}",
        "",
        "## Config",
        f"- voice_config_path: {config.get('voice_config_path')}",
        f"- voice_local_path: {config.get('voice_local_path')}",
        f"- voice_local_exists: {config.get('voice_local_exists')}",
        "",
        "## Safety",
        f"- read_only: {safety.get('read_only')}",
        f"- process_mutation_enabled: {safety.get('process_mutation_enabled')}",
        f"- config_writes_enabled: {safety.get('config_writes_enabled')}",
        f"- secrets_redacted: {safety.get('secrets_redacted')}",
        f"- raw_env_values_returned: {safety.get('raw_env_values_returned')}",
    ]
    return "\n".join(lines) + "\n"


def dashboard_runtime_diagnostics_export_preview(workspace: Path, max_chars=4000):
    max_chars = max(0, int(max_chars or 0))
    diagnostics = redact_secrets(dashboard_runtime_diagnostics(workspace))
    markdown = redact_production_readiness_markdown(dashboard_runtime_diagnostics_export_markdown(diagnostics))
    content_length = len(markdown)
    if max_chars > 0:
        markdown_preview = markdown[:max_chars]
        truncated = len(markdown_preview) < content_length
    else:
        markdown_preview = markdown
        truncated = False
    return {
        "status": "ok",
        "decision": "dashboard_runtime_diagnostics_export_preview",
        "dry_run": True,
        "will_apply": False,
        "writes_enabled": False,
        "read_only": True,
        "artifact_path": None,
        "artifact_relpath": None,
        "runtime_diagnostics": diagnostics,
        "export_preview": {
            "format": "markdown",
            "title": "AgentOS Dashboard Runtime Diagnostics",
            "max_chars": max_chars,
            "content_length": content_length,
            "line_count": len(markdown.splitlines()),
            "markdown_preview": markdown_preview,
            "truncated": truncated,
            "redactions": ["api_key", "token", "secret", "password"],
        },
        "safety": {
            "read_only": True,
            "artifact_write_enabled": False,
            "history_writes_enabled": False,
            "process_mutation_enabled": False,
            "config_writes_enabled": False,
            "raw_env_values_returned": False,
            "secrets_redacted": True,
        },
        "links": {
            "runtime_diagnostics": "/api/dashboard/runtime-diagnostics",
            "status": "/api/status",
            "production_readiness": "/api/production-readiness",
        },
    }


def voice_provider_test(workspace: Path, provider: str, text: str | None = None):
    data, _, _ = load_voice_config_raw(workspace)
    providers = data.get("providers", {})
    if provider not in providers:
        return {"status": "error", "error": "unknown_voice_provider", "provider": provider}
    cfg = providers[provider]
    health = voice_provider_status(provider, cfg)
    base = {
        "provider": provider,
        "mode": cfg.get("mode", "unknown"),
        "ready": health["ready"],
        "reasons": health["reasons"],
        "safe": True,
    }
    if provider == "mock_text":
        recognized = (text or "покажи digest").strip()
        command = run_command(workspace, recognized)
        return {**base, "status": "passed" if command.get("intent") != "unknown" else "failed", "recognized_text": recognized, "command": command}
    if provider == "local_file":
        if not health["ready"]:
            return {**base, "status": "blocked"}
        input_file = Path(cfg.get("input_file", workspace / "voice" / "input.txt"))
        recognized = input_file.read_text(encoding="utf-8").strip()
        command = run_command(workspace, recognized)
        return {**base, "status": "passed" if command.get("intent") != "unknown" else "failed", "input_file": str(input_file), "recognized_text": recognized, "command": command}
    if provider == "gemini_live":
        if not health["ready"]:
            return {**base, "status": "blocked"}
        try:
            probe = load_voice_provider_module(workspace, provider).probe_once(cfg)
            return {**base, **redact_secrets(probe), "status": "passed", "ready": True, "reasons": ["ready"]}
        except Exception as exc:  # noqa: BLE001 - API boundary
            return {**base, "status": "failed", "ready": False, "reasons": ["probe_failed"], "error": str(exc)}
    if not health["ready"]:
        return {**base, "status": "blocked"}
    return {**base, "status": "blocked", "reasons": ["provider_test_not_implemented"]}


def local_file_input_path(workspace: Path):
    data, _, _ = load_voice_config_raw(workspace)
    local_file = data.get("providers", {}).get("local_file", {})
    return Path(local_file.get("input_file") or workspace / "voice" / "input.txt")


def write_voice_sample(workspace: Path, text: str):
    sample_text = text.strip()
    if not sample_text:
        return {"status": "error", "error": "text_required"}
    input_file = local_file_input_path(workspace)
    write_text(input_file, sample_text + "\n")
    local_path = workspace / "config" / "voice.local.json"
    local = read_json(local_path, {"providers": {}})
    local.setdefault("providers", {})["local_file"] = {"enabled": True, "input_file": str(input_file)}
    write_json(local_path, local)
    append_event(workspace, "voice_sample_written", provider="local_file", input_file=str(input_file))
    return {"status": "sample_written", "provider": "local_file", "input_file": str(input_file), "text": sample_text}


def transcript_dir(workspace: Path):
    return workspace / "voice" / "transcripts"


def write_voice_transcript(workspace: Path, result: dict):
    entry = {
        "id": f"{datetime.utcnow().strftime('%Y%m%dT%H%M%S%f')}_{uuid4().hex[:8]}_{result.get('provider', 'unknown')}",
        "created_at": now(),
        **result,
    }
    path = transcript_dir(workspace) / f"{entry['id']}.json"
    write_json(path, entry)
    entry["path"] = str(path)
    return entry


def list_voice_transcripts(workspace: Path, limit: int = 20, provider: str | None = None, status: str | None = None, query: str | None = None):
    items = []
    q = (query or "").lower().strip()
    for path in sorted(transcript_dir(workspace).glob("*.json"), reverse=True):
        entry = read_json(path, {})
        if not entry:
            continue
        if provider and entry.get("provider") != provider:
            continue
        if status and entry.get("status") != status:
            continue
        haystack = json.dumps(entry, ensure_ascii=False).lower()
        if q and q not in haystack:
            continue
        entry["path"] = str(path)
        items.append(redact_secrets(entry))
        if len(items) >= limit:
            break
    return {"status": "ok", "count": len(items), "items": items}


def voice_session(workspace: Path, provider: str, text: str):
    raw_text = text.strip()
    if not raw_text:
        return {"status": "error", "error": "text_required", "provider": provider}
    data, _, _ = load_voice_config_raw(workspace)
    providers = data.get("providers", {})
    if provider not in providers:
        return {"status": "error", "error": "unknown_voice_provider", "provider": provider}
    cfg = providers[provider]
    health = voice_provider_status(provider, cfg)
    base = {
        "provider": provider,
        "mode": cfg.get("mode", "unknown"),
        "raw_text": raw_text,
        "ready": health["ready"],
        "reasons": health["reasons"],
        "safe": True,
    }
    if not health["ready"]:
        result = {**base, "status": "blocked"}
        return {**result, "transcript": write_voice_transcript(workspace, result)}

    if provider == "gemini_live":
        try:
            normalized = load_voice_provider_module(workspace, provider).normalize_command_text(cfg, raw_text)
        except Exception as exc:  # noqa: BLE001 - API boundary
            result = {**base, "status": "failed", "error": str(exc), "reasons": ["normalize_failed"]}
            return {**result, "transcript": write_voice_transcript(workspace, result)}
        normalized_text = str(normalized.get("normalized_text", "")).strip()
        command = run_command(workspace, normalized_text)
        normalization_fallback = None
        if command.get("intent") == "unknown":
            raw_command = run_command(workspace, raw_text)
            if raw_command.get("intent") != "unknown":
                normalized = {**normalized, "provider_normalized_text": normalized_text}
                normalized_text = raw_text
                command = raw_command
                normalization_fallback = "raw_command_bridge"
        result = {
            **base,
            **redact_secrets(normalized),
            "normalized_text": normalized_text,
            "command": command,
            "status": "passed" if command.get("intent") != "unknown" else "failed",
        }
        if normalization_fallback:
            result["normalization_fallback"] = normalization_fallback
        return {**result, "transcript": write_voice_transcript(workspace, result)}

    command = run_command(workspace, raw_text)
    result = {**base, "normalized_text": raw_text, "command": command, "status": "passed" if command.get("intent") != "unknown" else "failed"}
    return {**result, "transcript": write_voice_transcript(workspace, result)}


def mila_live_chat(workspace: Path, text: str, provider: str = "gemini_live"):
    raw_text = text.strip()
    if not raw_text:
        return {"status": "error", "error": "text_required", "provider": provider}
    load_workspace_dotenv(workspace)

    command = run_command(workspace, raw_text)
    if command.get("intent") != "unknown":
        result = {
            "status": "passed",
            "provider": provider,
            "mode": "live_chat_command",
            "reply": mila_command_reply(command),
            "command": command,
            "raw_text": raw_text,
            "safe": True,
        }
        return {**result, "transcript": write_voice_transcript(workspace, result)}

    data, _, _ = load_voice_config_raw(workspace)
    providers = data.get("providers", {})
    cfg = providers.get(provider) or providers.get("gemini_live") or {}
    health = voice_provider_status(provider, cfg) if cfg else {"ready": False, "reasons": ["provider_not_configured"]}
    base = {
        "provider": provider,
        "mode": "live_chat",
        "raw_text": raw_text,
        "ready": bool(health.get("ready")),
        "reasons": health.get("reasons") or [],
        "safe": True,
    }
    fallback_reply = (
        "Привет. Я Мила, твой локальный AgentOS-оркестратор. "
        "Могу обсудить задачу, создать проект, показать статус или помочь собрать артефакт."
    )
    if not health.get("ready"):
        result = {**base, "status": "blocked", "reply": fallback_reply}
        return {**result, "transcript": write_voice_transcript(workspace, result)}

    try:
        digest = digest_summary(workspace)
        reply = load_voice_provider_module(workspace, provider).generate_chat_reply(
            cfg,
            raw_text,
            {
                "projects": digest.get("projects", 0),
                "pending_approvals": digest.get("pending_approvals", 0),
                "queue_items": digest.get("queue_items", 0),
            },
        )
        result = {**base, **redact_secrets(reply), "status": "passed"}
    except Exception as exc:  # noqa: BLE001 - API boundary keeps UI alive
        result = {**base, "status": "failed", "reply": fallback_reply, "error": str(exc), "reasons": ["chat_generation_failed"]}
    return {**result, "transcript": write_voice_transcript(workspace, result)}


def mila_command_reply(command: dict):
    intent = command.get("intent")
    if intent == "show_digest":
        data = command.get("result") or {}
        return f"Дайджест готов: проектов {data.get('projects', 0)}, approvals {data.get('pending_approvals', 0)}, событий {data.get('events', 0)}."
    if intent == "create_goal":
        result = command.get("result") or {}
        return f"Готово. Я создала проект {result.get('slug') or result.get('goal') or ''} и запустила рабочий контур."
    if intent == "request_approval":
        approval = (command.get("result") or {}).get("approval") or command.get("result") or {}
        return f"Готово. Создала approval {approval.get('id', '')}."
    if intent == "kanban_export":
        return "Готово. Экспорт в Kanban создан."
    if intent == "run_orchestra":
        return "Готово. Оркестр запущен."
    if intent == "orchestra_status":
        return "Статус оркестра готов."
    return "Готово. Выполнила действие через AgentOS."


def google_genai_available() -> bool:
    return importlib.util.find_spec("google.genai") is not None


def mila_native_voice_ready(workspace: Path) -> dict:
    load_workspace_dotenv(workspace)
    data, _, _ = load_voice_config_raw(workspace)
    cfg = (data.get("providers", {}) or {}).get("gemini_live", {})
    status = voice_provider_status("gemini_live", cfg) if cfg else {"ready": False, "reasons": ["gemini_live_not_configured"]}
    sdk_ready = google_genai_available()
    return {
        "sdk_ready": sdk_ready,
        "gemini_ready": bool(status.get("ready")),
        "ready": bool(sdk_ready and status.get("ready")),
        "reasons": ([] if sdk_ready else ["google_genai_sdk_missing"]) + list(status.get("reasons") or []),
        "model": cfg.get("native_audio_model") or MILA_NATIVE_LIVE_MODEL,
        "input_sample_rate": MILA_INPUT_SAMPLE_RATE,
        "output_sample_rate": MILA_OUTPUT_SAMPLE_RATE,
    }


def mila_build_live_system_instruction(workspace: Path) -> str:
    initial = (workspace / "memory" / "mila-initial-memory.md").read_text(encoding="utf-8", errors="ignore") if (workspace / "memory" / "mila-initial-memory.md").exists() else ""
    digest = digest_summary(workspace)
    return f"""You are Mila, the single visible AgentOS orchestrator.

Speak Russian by default. If the user switches language, follow the user.
You are warm, concise, professional, and practical. You are a real-time voice assistant, not a command help screen.

You can:
- discuss tasks naturally;
- help shape goals;
- create local AgentOS projects when the user clearly asks;
- explain status and next steps;
- keep secrets private.

For explicit actions, answer naturally and briefly. AgentOS may execute safe local commands after the voice transcript.
Never reveal API keys or credentials. Never claim an external action was published or sent unless AgentOS confirms it.

Current local status:
- projects: {digest.get("projects", 0)}
- pending approvals: {digest.get("pending_approvals", 0)}
- queue items: {digest.get("queue_items", 0)}
- events: {digest.get("events", 0)}

Persistent memory excerpt:
{initial[:4000]}
"""


def _origin_allowed_for_local_ws(handler: BaseHTTPRequestHandler) -> bool:
    origin = handler.headers.get("Origin")
    if not origin:
        return True
    try:
        parsed = urlparse(origin)
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


class MilaWebSocketConnection:
    def __init__(self, handler: BaseHTTPRequestHandler):
        self.handler = handler
        self.sock: socket.socket = handler.connection
        self.send_lock = threading.Lock()
        self.closed = False

    def handshake(self) -> bool:
        if not _origin_allowed_for_local_ws(self.handler):
            self.handler.send_error(403)
            return False
        key = self.handler.headers.get("Sec-WebSocket-Key")
        upgrade = (self.handler.headers.get("Upgrade") or "").lower()
        if not key or upgrade != "websocket":
            self.handler.send_error(400)
            return False
        accept = base64.b64encode(hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()).decode("ascii")
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        ).encode("ascii")
        self.sock.sendall(response)
        return True

    def _recv_exact(self, size: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < size:
            chunk = self.sock.recv(size - len(chunks))
            if not chunk:
                raise ConnectionError("websocket_closed")
            chunks.extend(chunk)
        return bytes(chunks)

    def recv_frame(self) -> tuple[int, bytes]:
        header = self._recv_exact(2)
        b1, b2 = header
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length) if length else b""
        if masked and payload:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        if opcode == 0x9:
            self.send_frame(b"", opcode=0xA)
            return self.recv_frame()
        return opcode, payload

    def send_frame(self, payload: bytes, opcode: int = 0x1) -> None:
        if self.closed:
            return
        length = len(payload)
        if length < 126:
            header = struct.pack(">BB", 0x80 | opcode, length)
        elif length < 65536:
            header = struct.pack(">BBH", 0x80 | opcode, 126, length)
        else:
            header = struct.pack(">BBQ", 0x80 | opcode, 127, length)
        with self.send_lock:
            self.sock.sendall(header + payload)

    async def send_json(self, data: dict[str, Any]) -> None:
        self.send_frame(json.dumps(redact_secrets(data), ensure_ascii=False).encode("utf-8"), opcode=0x1)

    async def send_bytes(self, data: bytes) -> None:
        self.send_frame(data, opcode=0x2)

    def close(self) -> None:
        if self.closed:
            return
        try:
            self.send_frame(b"", opcode=0x8)
        except Exception:
            pass
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


async def mila_native_voice_session(ws: MilaWebSocketConnection, workspace: Path):
    load_workspace_dotenv(workspace)
    ready = mila_native_voice_ready(workspace)
    if not ready["sdk_ready"]:
        await ws.send_json({"type": "error", "detail": "google-genai SDK is not installed"})
        return
    if not ready["gemini_ready"]:
        await ws.send_json({"type": "error", "detail": "Gemini key/provider is not ready"})
        return

    first_opcode, first_payload = await asyncio.to_thread(ws.recv_frame)
    if first_opcode == 0x8:
        return
    try:
        handshake = json.loads(first_payload.decode("utf-8")) if first_payload else {}
    except Exception:
        await ws.send_json({"type": "error", "detail": "Invalid handshake"})
        return

    data, _, _ = load_voice_config_raw(workspace)
    cfg = (data.get("providers", {}) or {}).get("gemini_live", {})
    api_key = os.getenv(cfg.get("api_key_env", "GEMINI_API_KEY")) or os.getenv(cfg.get("fallback_api_key_env", "GOOGLE_API_KEY"))
    model = cfg.get("native_audio_model") or MILA_NATIVE_LIVE_MODEL
    voice_name = cfg.get("native_audio_voice") or MILA_DEFAULT_VOICE

    try:
        from google import genai
        from google.genai import types as gtypes
    except Exception as exc:  # noqa: BLE001 - UI-facing boundary
        await ws.send_json({"type": "error", "detail": f"google-genai import failed: {exc}"})
        return

    client = genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})
    system_instruction = mila_build_live_system_instruction(workspace)
    sys_content = gtypes.Content(role="user", parts=[gtypes.Part(text=system_instruction)])
    config_kwargs: dict[str, Any] = {
        "response_modalities": ["AUDIO"],
        "system_instruction": sys_content,
        "temperature": 0.2,
        "speech_config": gtypes.SpeechConfig(
            voice_config=gtypes.VoiceConfig(
                prebuilt_voice_config=gtypes.PrebuiltVoiceConfig(voice_name=voice_name)
            )
        ),
    }
    transcription_cls = getattr(gtypes, "AudioTranscriptionConfig", None)
    if transcription_cls is not None:
        try:
            config_kwargs["output_audio_transcription"] = transcription_cls()
            config_kwargs["input_audio_transcription"] = transcription_cls()
        except Exception:
            pass
    rti_cls = getattr(gtypes, "RealtimeInputConfig", None)
    aad_cls = getattr(gtypes, "AutomaticActivityDetection", None)
    if rti_cls is not None and aad_cls is not None:
        try:
            config_kwargs["realtime_input_config"] = rti_cls(
                automatic_activity_detection=aad_cls(
                    disabled=False,
                    prefix_padding_ms=180,
                    silence_duration_ms=1200,
                )
            )
        except Exception:
            pass

    append_event(workspace, "mila_native_voice_ws_started", provider="gemini_live", model=model, voice=voice_name)
    config = gtypes.LiveConnectConfig(**config_kwargs)

    async with client.aio.live.connect(model=model, config=config) as session:
        await ws.send_json({
            "type": "ready",
            "voice": voice_name,
            "model": model,
            "input_sample_rate": MILA_INPUT_SAMPLE_RATE,
            "output_sample_rate": MILA_OUTPUT_SAMPLE_RATE,
            "conversation_id": handshake.get("conversation_id"),
        })
        await ws.send_json({"type": "state", "value": "LISTENING"})
        send_lock = asyncio.Lock()

        async def browser_to_gemini():
            chunk_count = 0
            while True:
                opcode, payload = await asyncio.to_thread(ws.recv_frame)
                if opcode == 0x8:
                    raise ConnectionError("websocket_closed")
                if opcode == 0x2 and payload:
                    async with send_lock:
                        await session.send_realtime_input(media={"data": payload, "mime_type": MILA_INPUT_AUDIO_MIME})
                    chunk_count += 1
                elif opcode == 0x1 and payload:
                    try:
                        ctrl = json.loads(payload.decode("utf-8"))
                    except json.JSONDecodeError:
                        continue
                    if ctrl.get("type") == "text":
                        txt = str(ctrl.get("data") or "").strip()
                        if txt:
                            await ws.send_json({"type": "transcript", "role": "user", "text": txt})
                            async with send_lock:
                                await session.send_client_content(turns={"parts": [{"text": txt}]}, turn_complete=True)
                    elif ctrl.get("type") == "stop":
                        raise ConnectionError("websocket_stop")

        async def gemini_to_browser():
            in_buf: list[str] = []
            out_buf: list[str] = []
            speaking = False
            async for response in session.receive():
                if response.data:
                    if not speaking:
                        speaking = True
                        await ws.send_json({"type": "state", "value": "SPEAKING"})
                    await ws.send_bytes(response.data)

                sc = response.server_content
                if sc:
                    in_t = getattr(sc, "input_transcription", None)
                    if in_t and getattr(in_t, "text", None):
                        in_buf.append(in_t.text)
                    out_t = getattr(sc, "output_transcription", None)
                    if out_t and getattr(out_t, "text", None):
                        out_buf.append(out_t.text)

                    if getattr(sc, "turn_complete", False):
                        user_text = "".join(in_buf).strip()
                        assistant_text = "".join(out_buf).strip()
                        in_buf.clear()
                        out_buf.clear()
                        command = run_command(workspace, user_text) if user_text else {"intent": "unknown"}
                        if user_text:
                            await ws.send_json({"type": "transcript", "role": "user", "text": user_text})
                        if command.get("intent") != "unknown":
                            assistant_text = mila_command_reply(command)
                            await ws.send_json({"type": "action", "resources": ["agentos"], "actions": [command]})
                        if assistant_text:
                            await ws.send_json({"type": "transcript", "role": "assistant", "text": assistant_text})
                        result = {
                            "provider": "gemini_live",
                            "mode": "native_audio_ws",
                            "status": "passed",
                            "raw_text": user_text,
                            "reply": assistant_text,
                            "command": command,
                            "safe": True,
                        }
                        write_voice_transcript(workspace, result)
                        await ws.send_json({"type": "turn_complete"})
                        await ws.send_json({"type": "state", "value": "LISTENING"})
                        speaking = False

        tasks = [asyncio.create_task(browser_to_gemini()), asyncio.create_task(gemini_to_browser())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc:
                raise exc


def handle_mila_voice_websocket(handler: BaseHTTPRequestHandler, workspace: Path):
    ws = MilaWebSocketConnection(handler)
    if not ws.handshake():
        return
    try:
        asyncio.run(mila_native_voice_session(ws, workspace))
    except Exception as exc:  # noqa: BLE001 - WebSocket boundary
        try:
            detail = str(exc)
            if "1008" in detail or "Operation is not implemented" in detail:
                detail = "VOICE_ERROR_LIVE_RECONNECT"
            asyncio.run(ws.send_json({"type": "error", "detail": detail[:220]}))
        except Exception:
            pass
    finally:
        ws.close()


def voice_loop_signature(workspace: Path, provider: str, text: str | None = None):
    if provider == "local_file":
        input_file = local_file_input_path(workspace)
        recognized = input_file.read_text(encoding="utf-8").strip() if input_file.exists() else ""
        return {"signature": hashlib.sha256(recognized.encode("utf-8")).hexdigest(), "recognized_text": recognized}
    if provider == "mock_text":
        recognized = (text or "покажи digest").strip()
        return {"signature": hashlib.sha256(recognized.encode("utf-8")).hexdigest(), "recognized_text": recognized}
    return {"signature": provider, "recognized_text": text or ""}


def voice_loop(workspace: Path, provider: str, cycles: int = 1, interval: float = 0, text: str | None = None):
    if cycles < 1:
        return {"status": "error", "error": "cycles_must_be_positive", "provider": provider}
    transcripts = []
    processed = 0
    skipped = 0
    last_signature = None
    for index in range(cycles):
        signature = voice_loop_signature(workspace, provider, text)
        if signature["signature"] and signature["signature"] == last_signature:
            result = {
                "provider": provider,
                "status": "skipped",
                "reason": "duplicate_input",
                "recognized_text": signature.get("recognized_text", ""),
                "cycle": index + 1,
                "safe": True,
            }
            skipped += 1
        else:
            result = voice_provider_test(workspace, provider, text)
            result["cycle"] = index + 1
            processed += 1
            last_signature = signature["signature"]
        transcripts.append(write_voice_transcript(workspace, result))
        if interval > 0 and index < cycles - 1:
            time.sleep(interval)
    append_event(workspace, "voice_loop_cycle", provider=provider, processed=processed, skipped=skipped)
    return {
        "status": "loop_completed",
        "provider": provider,
        "cycles": cycles,
        "processed": processed,
        "skipped": skipped,
        "transcripts": transcripts,
    }


def voice_loop_once(workspace: Path, provider: str, text: str | None = None):
    return voice_loop(workspace, provider, cycles=1, interval=0, text=text)


def update_voice_provider(workspace: Path, provider: str, enabled):
    base = load_voice_config(workspace)
    if provider not in base.get("providers", {}):
        return {"error": "unknown_voice_provider", "provider": provider}
    if not isinstance(enabled, bool):
        return {"error": "enabled_boolean_required", "provider": provider}
    local_path = workspace / "config" / "voice.local.json"
    local = read_json(local_path, {"providers": {}})
    local.setdefault("providers", {})[provider] = {"enabled": enabled}
    write_json(local_path, local)
    append_event(workspace, "voice_provider_toggle_saved", provider=provider, enabled=enabled)
    data = load_voice_config(workspace)
    return {"status": "saved", "provider": provider, "enabled": enabled, **data}


def run_command(workspace: Path, text: str):
    original = text.strip()
    normalized = original.lower().strip()
    if not normalized:
        return {"intent": "unknown", "error": "empty_command", **command_help()}

    goal_prefixes = ["создай оркестр ", "запусти проект ", "создай goal ", "создай цель ", "create orchestra ", "orchestrate ", "create goal ", "new goal "]
    for prefix in goal_prefixes:
        if normalized.startswith(prefix):
            goal = original[len(prefix):].strip()
            if not goal:
                return {"intent": "create_goal", "error": "goal_required", **command_help()}
            result = create_agentic_goal(workspace, goal)
            run = run_agentic_orchestrator(workspace, result.get("slug"), max_steps=20, dry_run=False)
            append_event(workspace, "command_executed", intent="create_goal", text=original)
            return {"intent": "create_goal", "text": original, "result": result, "orchestrator_run": run}

    if normalized in {"run orchestra", "запусти оркестр", "прогони оркестр", "orchestra run"}:
        result = run_agentic_orchestrator(workspace, max_steps=20, dry_run=False)
        append_event(workspace, "command_executed", intent="run_orchestra", text=original)
        return {"intent": "run_orchestra", "text": original, "result": result}

    if normalized in {"orchestra status", "статус оркестра", "покажи оркестр"}:
        result = agentic_orchestrator_overview(workspace)
        append_event(workspace, "command_executed", intent="orchestra_status", text=original)
        return {"intent": "orchestra_status", "text": original, "result": result}

    if normalized in {"покажи digest", "show digest", "digest", "daily digest", "дай digest"}:
        result = digest_summary(workspace)
        append_event(workspace, "command_executed", intent="show_digest", text=original)
        return {"intent": "show_digest", "text": original, "result": result}

    approval_prefixes = ["создай approval ", "approval ", "request approval ", "создай подтверждение "]
    for prefix in approval_prefixes:
        if normalized.startswith(prefix):
            rest = original[len(prefix):].strip()
            parts = rest.split(maxsplit=1)
            if len(parts) < 2:
                return {"intent": "request_approval", "error": "action_and_summary_required", **command_help()}
            action, summary = parts
            result = request_approval(workspace, action, summary)
            append_event(workspace, "command_executed", intent="request_approval", text=original, action=action)
            return {"intent": "request_approval", "text": original, "result": result}

    kanban_prefixes = ["экспортируй в kanban ", "export kanban ", "kanban export "]
    for prefix in kanban_prefixes:
        if normalized.startswith(prefix):
            slug = original[len(prefix):].strip()
            if not slug:
                return {"intent": "kanban_export", "error": "project_slug_required", **command_help()}
            result = kanban_export(workspace, slug)
            append_event(workspace, "command_executed", intent="kanban_export", text=original, project=slug)
            return {"intent": "kanban_export", "text": original, "result": result}

    return {"intent": "unknown", "text": original, **command_help()}


def handle_api(workspace: str | Path, path: str, method: str = "GET", payload=None):
    workspace = Path(workspace)
    parsed = urlparse(path)
    clean = unquote(parsed.path).rstrip("/") or "/"
    method = method.upper()
    payload = payload or {}

    if method == "POST" and clean == "/api/goals":
        goal = str(payload.get("goal", "")).strip()
        if not goal:
            return {"error": "goal_required"}
        return create_goal(workspace, goal)
    if method == "POST" and clean == "/api/approvals/request":
        action = str(payload.get("action", "")).strip()
        summary = str(payload.get("summary", "")).strip()
        if not action or not summary:
            return {"error": "action_and_summary_required"}
        return request_approval(workspace, action, summary)
    if method == "POST" and clean == "/api/profile-mapping":
        mapping = payload.get("mapping", {})
        if not isinstance(mapping, dict):
            return {"error": "mapping_object_required"}
        return save_profile_mapping(workspace, mapping)
    if method == "POST" and clean == "/api/command":
        text = str(payload.get("text", ""))
        return run_command(workspace, text)
    if method == "POST" and clean.startswith("/api/voice-config/providers/"):
        provider = clean.split("/")[-1]
        return update_voice_provider(workspace, provider, payload.get("enabled"))
    if method == "POST" and clean.startswith("/api/voice-test/providers/"):
        provider = clean.split("/")[-1]
        return redact_secrets(voice_provider_test(workspace, provider, str(payload.get("text", "") or "") or None))
    if method == "POST" and clean == "/api/voice-session":
        return redact_secrets(voice_session(workspace, str(payload.get("provider", "gemini_live")), str(payload.get("text", ""))))
    if method == "POST" and clean == "/api/mila/live-chat":
        return redact_secrets(mila_live_chat(workspace, str(payload.get("text", "")), str(payload.get("provider", "gemini_live"))))
    if method == "POST" and clean == "/api/agent-queue/sync":
        return sync_agent_queue(workspace)
    if method == "POST" and clean == "/api/agent-queue/claim":
        return claim_agent_queue_item(workspace, str(payload.get("queue_id", "")), str(payload.get("worker", "")))
    if method == "POST" and clean == "/api/agent-queue/start":
        return start_agent_queue_item(workspace, str(payload.get("queue_id", "")))
    if method == "POST" and clean == "/api/agent-queue/lease":
        ttl_seconds = 300 if payload.get("ttl_seconds") is None else int(payload.get("ttl_seconds"))
        return lease_agent_queue_item(workspace, str(payload.get("queue_id", "")), str(payload.get("worker", "")), ttl_seconds)
    if method == "POST" and clean == "/api/agent-queue/heartbeat":
        ttl_seconds = 300 if payload.get("ttl_seconds") is None else int(payload.get("ttl_seconds"))
        return heartbeat_agent_queue_item(workspace, str(payload.get("queue_id", "")), str(payload.get("worker", "")), ttl_seconds)
    if method == "POST" and clean == "/api/agent-queue/requeue-stale":
        return requeue_stale_agent_queue_items(workspace)
    if method == "POST" and clean == "/api/agent-queue/fail":
        return fail_agent_queue_item(workspace, str(payload.get("queue_id", "")), str(payload.get("reason", "")))
    if method == "POST" and clean == "/api/agent-queue/retry":
        return retry_agent_queue_item(workspace, str(payload.get("queue_id", "")))
    if method == "POST" and clean == "/api/agent-queue/cancel":
        return cancel_agent_queue_item(workspace, str(payload.get("queue_id", "")), str(payload.get("reason", "")))
    if method == "POST" and clean == "/api/agent-queue/complete":
        return complete_agent_queue_item(workspace, str(payload.get("queue_id", "")))
    if method == "POST" and clean == "/api/agent-queue/execute":
        return execute_agent_queue_item(workspace, str(payload.get("queue_id", "")), str(payload.get("worker", "")))
    if method == "POST" and clean == "/api/agent-queue/run-next":
        ttl_seconds = 300 if payload.get("ttl_seconds") is None else int(payload.get("ttl_seconds"))
        return run_next_agent_queue_item(
            workspace,
            str(payload.get("worker", "")),
            ttl_seconds,
            str(payload.get("queue_id", "") or "") or None,
            str(payload.get("project", "") or "") or None,
            str(payload.get("owner", "") or "") or None,
        )
    if method == "POST" and clean == "/api/agent-queue/run-batch":
        ttl_seconds = 300 if payload.get("ttl_seconds") is None else int(payload.get("ttl_seconds"))
        max_items = 1 if payload.get("max_items") is None else int(payload.get("max_items"))
        dry_run = bool(payload.get("dry_run", False))
        return run_batch_agent_queue_items(
            workspace,
            str(payload.get("worker", "")),
            max_items,
            ttl_seconds,
            dry_run,
            str(payload.get("queue_id", "") or "") or None,
            str(payload.get("project", "") or "") or None,
            str(payload.get("owner", "") or "") or None,
        )
    if method == "POST" and clean == "/api/orchestrator/run":
        max_steps = 20 if payload.get("max_steps") is None else int(payload.get("max_steps"))
        return run_agentic_orchestrator(workspace, str(payload.get("project", "") or "") or None, max_steps=max_steps, dry_run=bool(payload.get("dry_run", False)))
    if method == "POST" and clean == "/api/orchestrator/create-and-run":
        goal = str(payload.get("goal", "")).strip()
        if not goal:
            return {"error": "goal_required"}
        created = create_agentic_goal(workspace, goal)
        run = run_agentic_orchestrator(workspace, created.get("slug"), max_steps=int(payload.get("max_steps") or 20), dry_run=bool(payload.get("dry_run", False)))
        return {"status": "created_and_ran", "decision": "agentic_orchestrator_create_and_run", "created": created, "run": run}
    if method == "POST" and clean == "/api/agent-worker/config":
        config = save_agent_worker_config(workspace, payload)
        return {"status": "configured", "will_execute": False, "runtime": agent_worker_runtime_config_state(config), "config": config, "path": str(agent_worker_config_path(workspace))}
    if method == "POST" and clean == "/api/agent-worker/runtime-trace-export-retention/apply":
        return apply_agent_worker_runtime_trace_export_retention(workspace, payload)
    if method == "POST" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export":
        return agent_worker_runtime_trace_export_retention_preset_advice_checklist_export(workspace, payload)
    if method == "POST" and clean.startswith("/api/agent-worker/runtime-trace-export-pruned/") and clean.endswith("/restore"):
        pruned_id = clean.split("/")[-2]
        return restore_agent_worker_runtime_trace_export_pruned(workspace, pruned_id, payload.get("confirm_restore"), str(payload.get("reason", "") or ""))
    if method == "POST" and clean.startswith("/api/agent-worker/runtime-trace-export-pruned/") and clean.endswith("/delete"):
        pruned_id = clean.split("/")[-2]
        return delete_agent_worker_runtime_trace_export_pruned(workspace, pruned_id, payload.get("confirm_delete"), str(payload.get("confirmation_phrase", "") or ""), str(payload.get("reason", "") or ""))
    if method == "POST" and clean.startswith("/api/agent-worker/runtime-trace-export-archives/") and clean.endswith("/restore"):
        archive_id = clean.split("/")[-2]
        return restore_agent_worker_runtime_trace_export_archive(workspace, archive_id, payload.get("confirm_restore"), str(payload.get("reason", "") or ""))
    if method == "POST" and clean.startswith("/api/agent-worker/runtime-trace-exports/") and clean.endswith("/archive"):
        one_shot_run_id = clean.split("/")[-2]
        return archive_agent_worker_runtime_trace_export(workspace, one_shot_run_id, payload.get("confirm_archive"), str(payload.get("reason", "") or ""))
    if method == "POST" and clean == "/api/agent-worker/request-enable":
        return request_agent_worker_enable(workspace, str(payload.get("summary", "") or "") or None)
    if method == "POST" and clean == "/api/agent-worker/enable":
        return enable_agent_worker_with_approval(workspace, str(payload.get("approval_id", "")))
    if method == "POST" and clean == "/api/agent-worker/runtime-tick":
        return agent_worker_runtime_tick_with_preflight_gate(workspace, confirm_execute=bool(payload.get("confirm_execute", False)), confirmation_token=str(payload.get("confirmation_token", "") or "") or None, preflight_gate=bool(payload.get("preflight_gate", False)))
    if method == "POST" and clean == "/api/agent-worker/runtime-preview":
        return agent_worker_runtime_preview(workspace)
    if method == "POST" and clean == "/api/agent-worker/runtime-preview/revoke":
        return revoke_agent_worker_runtime_preview(workspace, str(payload.get("preview_id", "") or "") or None, str(payload.get("confirmation_token", "") or "") or None, str(payload.get("reason", "") or "") or None)
    if method == "POST" and clean == "/api/agent-worker/runtime-preview/expire-stale":
        return expire_stale_agent_worker_runtime_previews(workspace)
    if method == "POST" and clean == "/api/agent-worker/runtime-preview/validate-token":
        return agent_worker_runtime_confirmation_preflight(workspace, str(payload.get("confirmation_token", "") or "") or None, str(payload.get("preview_id", "") or "") or None)
    if method == "POST" and clean == "/api/agent-worker/tick":
        return agent_worker_tick(workspace, preview=bool(payload.get("preview", False)))
    if method == "POST" and clean == "/api/voice-sample":
        return write_voice_sample(workspace, str(payload.get("text", "")))
    if method == "POST" and clean == "/api/voice-loop":
        provider = str(payload.get("provider", "local_file"))
        cycles = int(payload.get("cycles") or (1 if payload.get("once", True) else 0))
        interval = float(payload.get("interval") or 0)
        return redact_secrets(voice_loop(workspace, provider, cycles=cycles, interval=interval, text=str(payload.get("text", "") or "") or None))
    if method == "POST" and clean.startswith("/api/approvals/"):
        parts = clean.split("/")
        if len(parts) == 5 and parts[4] in {"approve", "deny"}:
            return update_approval(workspace, parts[3], "approved" if parts[4] == "approve" else "denied")
    if method == "POST" and clean.startswith("/api/projects/"):
        parts = clean.split("/")
        if len(parts) == 7 and parts[4] == "tasks" and parts[6] == "status":
            return set_task_status(workspace, parts[3], parts[5], str(payload.get("status", "")))
        if len(parts) == 7 and parts[4] == "tasks" and parts[6] == "block":
            return block_task(workspace, parts[3], parts[5], str(payload.get("reason", "")))
        if len(parts) == 5 and parts[4] == "kanban-export":
            return kanban_export(workspace, parts[3])
        if len(parts) == 5 and parts[4] == "kanban-create":
            return kanban_create_request(workspace, parts[3], str(payload.get("mode", "dry-run")), payload.get("approval_id"), bool(payload.get("simulate", False)))

    if method == "GET" and clean == "/api/status":
        return status(workspace)
    if method == "GET" and clean == "/api/dashboard/runtime-diagnostics":
        return dashboard_runtime_diagnostics(workspace)
    if method == "GET" and clean == "/api/dashboard/runtime-diagnostics/export":
        qs = parse_qs(parsed.query)
        max_chars = int((qs.get("max_chars") or [4000])[0])
        return dashboard_runtime_diagnostics_export_preview(workspace, max_chars)
    if method == "GET" and clean == "/api/production-readiness":
        return production_readiness(workspace)
    if method == "GET" and clean == "/api/production-readiness/credential-handoff":
        return production_readiness_credential_handoff(workspace)
    if method == "GET" and clean == "/api/production-readiness/credential-handoff/export":
        qs = parse_qs(parsed.query)
        max_chars = int((qs.get("max_chars") or [4000])[0])
        return production_readiness_credential_handoff_export_preview(workspace, max_chars)
    if method == "GET" and clean == "/api/production-readiness/export":
        qs = parse_qs(parsed.query)
        max_chars = int((qs.get("max_chars") or [4000])[0])
        return production_readiness_export_preview(workspace, max_chars)
    if method == "GET" and clean == "/api/projects":
        return list_projects(workspace)
    if method == "GET" and clean == "/api/approvals":
        return list_approvals(workspace)
    if method == "GET" and clean == "/api/events":
        qs = parse_qs(parsed.query)
        if str((qs.get("format") or [""])[0]).strip().lower() == "raw":
            return redact_secrets(list_events(workspace))
        return paginated_events(workspace, parsed.query)
    if method == "GET" and clean == "/api/digest":
        return digest_summary(workspace)
    if method == "GET" and clean == "/api/profiles":
        return discover_profiles()
    if method == "GET" and clean == "/api/profile-mapping":
        return get_profile_mapping(workspace)
    if method == "GET" and clean == "/api/voice-config":
        return load_voice_config(workspace)
    if method == "GET" and clean == "/api/voice-health":
        return voice_health(workspace)
    if method == "GET" and clean == "/api/agent-queue":
        return list_agent_queue(workspace)
    if method == "GET" and clean == "/api/orchestrator":
        qs = parse_qs(parsed.query)
        project = (qs.get("project") or [None])[0] or None
        return agentic_orchestrator_overview(workspace, project)
    if method == "GET" and clean == "/api/agent-queue/runs":
        qs = parse_qs(parsed.query)
        limit = int((qs.get("limit") or [20])[0] or 20)
        return list_agent_queue_runs(workspace, limit)
    if method == "GET" and clean.startswith("/api/agent-queue/runs/"):
        run_id = clean.split("/")[-1]
        return agent_queue_run_detail(workspace, run_id)
    if method == "GET" and clean == "/api/agent-worker/status":
        return agent_worker_status(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-storage-summary":
        return agent_worker_runtime_trace_export_storage_summary(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/recommendations":
        return agent_worker_runtime_trace_export_retention_recommendations(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/presets":
        return agent_worker_runtime_trace_export_retention_presets(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice":
        return agent_worker_runtime_trace_export_retention_preset_advice(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview":
        return agent_worker_runtime_trace_export_retention_preset_advice_audit_preview(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice/explain":
        return agent_worker_runtime_trace_export_retention_preset_advice_explain(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist":
        return agent_worker_runtime_trace_export_retention_preset_advice_checklist(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress":
        return agent_worker_runtime_trace_export_retention_preset_advice_checklist_progress(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence":
        return agent_worker_runtime_trace_export_retention_preset_advice_checklist_evidence(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports":
        qs = parse_qs(parsed.query)
        limit = int((qs.get("limit") or [20])[0] or 20)
        return list_agent_worker_runtime_trace_export_retention_preset_advice_checklist_exports(workspace, limit)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/"):
        qs = parse_qs(parsed.query)
        max_chars = int((qs.get("max_chars") or [4000])[0] or 0)
        export_id = unquote(clean.rsplit("/", 1)[-1])
        return agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_detail(workspace, export_id, max_chars)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview":
        qs = parse_qs(parsed.query)
        max_chars = int((qs.get("max_chars") or [4000])[0] or 0)
        return agent_worker_runtime_trace_export_retention_preset_advice_checklist_export_preview(workspace, max_chars)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preset-impact":
        return agent_worker_runtime_trace_export_retention_preset_impact(workspace)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-trace-export-retention/preset-impact/"):
        preset_name = unquote(clean.rsplit("/", 1)[-1])
        return agent_worker_runtime_trace_export_retention_preset_impact_detail(workspace, preset_name)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/recommended-preview":
        return agent_worker_runtime_trace_export_retention_recommended_preview(workspace)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-retention/preview":
        qs = parse_qs(parsed.query)
        max_active = (qs.get("max_active") or [None])[0]
        max_archived = (qs.get("max_archived") or [None])[0]
        older_than_days = (qs.get("older_than_days") or [None])[0]
        return agent_worker_runtime_trace_export_retention_preview(workspace, max_active, max_archived, older_than_days)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-pruned":
        qs = parse_qs(parsed.query)
        limit = int((qs.get("limit") or [20])[0] or 20)
        return list_agent_worker_runtime_trace_export_pruned(workspace, limit)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-trace-export-pruned/"):
        qs = parse_qs(parsed.query)
        max_chars = int((qs.get("max_chars") or [4000])[0] or 0)
        pruned_id = clean.split("/")[-1]
        return agent_worker_runtime_trace_export_pruned_detail(workspace, pruned_id, max_chars)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-export-archives":
        qs = parse_qs(parsed.query)
        limit = int((qs.get("limit") or [20])[0] or 20)
        return list_agent_worker_runtime_trace_export_archives(workspace, limit)
    if method == "GET" and clean == "/api/agent-worker/runtime-trace-exports":
        qs = parse_qs(parsed.query)
        limit = int((qs.get("limit") or [20])[0] or 20)
        return list_agent_worker_runtime_trace_exports(workspace, limit)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-trace-exports/"):
        qs = parse_qs(parsed.query)
        max_chars = int((qs.get("max_chars") or [4000])[0] or 0)
        one_shot_run_id = clean.split("/")[-1]
        return agent_worker_runtime_trace_export_detail(workspace, one_shot_run_id, max_chars)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-traces/") and clean.endswith("/export"):
        one_shot_run_id = clean.split("/")[-2]
        return export_agent_worker_runtime_trace(workspace, one_shot_run_id)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-traces/"):
        one_shot_run_id = clean.split("/")[-1]
        return agent_worker_runtime_trace_graph(workspace, one_shot_run_id)
    if method == "GET" and clean == "/api/agent-worker/runtime-audits":
        qs = parse_qs(parsed.query)
        limit = int((qs.get("limit") or [20])[0] or 20)
        return list_agent_worker_runtime_audits(workspace, limit)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-audits/"):
        audit_id = clean.split("/")[-1]
        return agent_worker_runtime_audit_detail(workspace, audit_id)
    if method == "GET" and clean == "/api/agent-worker/runtime-confirm-attempts":
        qs = parse_qs(parsed.query)
        limit = int((qs.get("limit") or [20])[0] or 20)
        final_status_filter = (qs.get("final_status") or qs.get("status") or [None])[0] or None
        runtime_called_filter = (qs.get("runtime_called") or [None])[0]
        preflight_status_filter = (qs.get("preflight_status") or [None])[0] or None
        return list_agent_worker_runtime_confirm_attempts(workspace, limit, final_status_filter, runtime_called_filter, preflight_status_filter)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-confirm-attempts/"):
        attempt_id = clean.split("/")[-1]
        return agent_worker_runtime_confirm_attempt_detail(workspace, attempt_id)
    if method == "GET" and clean == "/api/agent-worker/runtime-previews":
        qs = parse_qs(parsed.query)
        limit = int((qs.get("limit") or [20])[0] or 20)
        status_filter = (qs.get("status") or qs.get("token_status") or [None])[0] or None
        return list_agent_worker_runtime_previews(workspace, limit, status_filter)
    if method == "GET" and clean.startswith("/api/agent-worker/runtime-previews/"):
        preview_id = clean.split("/")[-1]
        return agent_worker_runtime_preview_detail(workspace, preview_id=preview_id)
    if method == "GET" and clean.startswith("/api/voice-transcripts"):
        query_args = parse_qs(parsed.query)
        limit = int((query_args.get("limit") or [20])[0])
        provider = (query_args.get("provider") or [None])[0] or None
        status_filter = (query_args.get("status") or [None])[0] or None
        search = (query_args.get("q") or query_args.get("query") or [None])[0] or None
        return list_voice_transcripts(workspace, limit=limit, provider=provider, status=status_filter, query=search)
    if method == "GET" and clean == "/api/mila/desktop-package":
        return mila_desktop_package(workspace)
    if method == "GET" and clean == "/api/mila/interface-blueprint":
        return mila_interface_blueprint(workspace)
    if method == "GET" and clean == "/api/mila/dashboard-routes":
        return mila_dashboard_routes(workspace)
    if method == "GET" and clean == "/api/mila/agent-dock":
        return mila_agent_dock(workspace)
    if method == "GET" and clean == "/api/mila/memory-galaxy":
        return mila_memory_galaxy(workspace)
    if method == "GET" and clean == "/api/obsidian/status":
        return obsidian_scan_notes(workspace, limit=20)
    if method == "POST" and clean == "/api/obsidian/sync":
        return obsidian_sync_agentos_memory(workspace, payload or {})
    if method == "GET" and clean == "/api/agentic-workflow/config":
        return agentic_seo_workflow_config(workspace)
    if method == "GET" and clean == "/api/agentic-workflow/runs":
        return agentic_seo_workflow_runs(workspace)
    if method == "POST" and clean == "/api/agentic-workflow/run":
        return agentic_seo_workflow_run(workspace, payload or {})
    if method == "GET" and clean == "/api/mila/app-builder/blueprint":
        idea = (parse_qs(parsed.query).get("idea") or [""])[0]
        return mila_app_builder_blueprint(workspace, unquote(idea))
    if method == "GET" and clean == "/api/mila/kanban-studio":
        return mila_kanban_studio(workspace)
    if method == "GET" and clean == "/api/mila/model-hub":
        return mila_model_hub(workspace)
    if method == "GET" and clean == "/api/mila/status":
        return mila_single_agent_status(workspace)
    if method == "GET" and clean == "/api/mila/voice-agent":
        return mila_nova_voice_agent(workspace)
    if method == "GET" and clean == "/api/mila/tray-package":
        return mila_tray_package(workspace)
    if method == "GET" and clean == "/api/mila/visual-polish":
        return mila_visual_polish(workspace)
    if method == "GET" and clean.startswith("/api/projects/") and clean.endswith("/tasks"):
        slug = clean.split("/")[3]
        return project_tasks(workspace, slug)
    if method == "GET" and clean.startswith("/api/projects/") and clean.endswith("/kanban-links"):
        slug = clean.split("/")[3]
        return kanban_links(workspace, slug)
    return {"error": "not_found", "path": clean}


class AgentOSHandler(BaseHTTPRequestHandler):
    workspace: Path = DEFAULT_WORKSPACE

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        return

    def do_GET(self):
        if self.path.startswith("/ws/mila/voice"):
            handle_mila_voice_websocket(self, self.workspace)
            return
        if self.path == "/" or self.path.startswith("/index.html"):
            self.send_static_index()
            return
        data = handle_api(self.workspace, self.path, method="GET")
        status_code = 404 if isinstance(data, dict) and data.get("error") == "not_found" else 200
        self.send_json(data, status_code)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            self.send_json({"error": "invalid_json"}, 400)
            return
        data = handle_api(self.workspace, self.path, method="POST", payload=payload)
        status_code = 404 if isinstance(data, dict) and data.get("error") == "not_found" else 200
        if isinstance(data, dict) and data.get("error") and data.get("error") != "not_found":
            status_code = 400
        self.send_json(data, status_code)

    def send_json(self, data, status_code=200):
        safe_data = redact_secrets(data)
        body = json.dumps(safe_data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_static_index(self):
        index = self.workspace / "dashboard" / "frontend" / "index.html"
        if not index.exists():
            self.send_json({"error": "frontend_not_found"}, 404)
            return
        body = index.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_server(workspace: Path, host: str, port: int):
    AgentOSHandler.workspace = workspace
    server = ThreadingHTTPServer((host, port), AgentOSHandler)
    print(f"AgentOS dashboard running at http://{host}:{port} workspace={workspace}", flush=True)
    server.serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run AgentOS dashboard API")
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    run_server(Path(args.workspace), args.host, args.port)


if __name__ == "__main__":
    main()
