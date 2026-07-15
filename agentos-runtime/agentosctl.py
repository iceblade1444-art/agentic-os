#!/usr/bin/env python
"""agentosctl — local control CLI for the AgentOS workspace."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4

from agentos_env import load_workspace_dotenv

DEFAULT_WORKSPACE = Path("C:/Users/User/AgentOS")
CORE_DIRS = [
    "agents",
    "workflows",
    "memory",
    "sops",
    "projects",
    "drafts",
    "approvals",
    "logs/daily",
    "artifacts",
    "exports/kanban",
    "scripts",
    "cron",
    "dashboard/backend",
    "dashboard/frontend",
]


def now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    return slug[:80] or f"goal-{datetime.now().strftime('%Y%m%d%H%M%S')}"


def read_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def read_text(path: Path, default: str = "") -> str:
    if not path.exists():
        return default
    return path.read_text(encoding="utf-8")


def workspace_from_args(args) -> Path:
    return Path(args.workspace).expanduser().resolve()


def ensure_workspace(workspace: Path) -> None:
    for directory in CORE_DIRS:
        (workspace / directory).mkdir(parents=True, exist_ok=True)
    readme = workspace / "README.md"
    if not readme.exists():
        write_text(
            readme,
            "# AgentOS\n\nLocal-first Agentic OS workspace controlled by `agentosctl`.\n",
        )


def cmd_init(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps({"status": "initialized", "workspace": str(workspace)}, ensure_ascii=False))
    return 0


def default_tasks(goal: str, project_slug: str):
    return [
        {
            "id": "T001",
            "project": project_slug,
            "objective": "Create project brief and acceptance criteria",
            "owner": "orchestrator",
            "status": "done",
            "depends_on": [],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Project goal is captured", "Tasks are defined"],
            "artifacts": ["project-brief.md"],
            "block_reason": None,
        },
        {
            "id": "T002",
            "project": project_slug,
            "objective": "Draft content/copy for the goal",
            "owner": "content-agent",
            "status": "planned",
            "depends_on": ["T001"],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Draft includes audience, core promise, and body"],
            "artifacts": ["copy.md"],
            "block_reason": None,
        },
        {
            "id": "T003",
            "project": project_slug,
            "objective": "Implement local artifact",
            "owner": "coding-agent",
            "status": "planned",
            "depends_on": ["T002"],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["Artifact exists", "Artifact is locally verifiable"],
            "artifacts": ["index.html"],
            "block_reason": None,
        },
        {
            "id": "T004",
            "project": project_slug,
            "objective": "Verify artifact against acceptance criteria",
            "owner": "qa-agent",
            "status": "planned",
            "depends_on": ["T003"],
            "risk_level": "low",
            "requires_approval": False,
            "acceptance_criteria": ["QA evidence saved", "Failures are blocked with reasons"],
            "artifacts": ["qa-report.md"],
            "block_reason": None,
        },
    ]


def project_brief(goal: str, slug: str, tasks) -> str:
    rows = "\n".join(
        f"| {t['id']} | {t['objective']} | {t['owner']} | {', '.join(t['depends_on']) or 'none'} | {t['risk_level']} | {', '.join(t['artifacts'])} | {'; '.join(t['acceptance_criteria'])} |"
        for t in tasks
    )
    return f"""# Project Brief: {goal}

## Goal
{goal}

## Project slug
`{slug}`

## Task graph

| ID | Task | Owner | Depends on | Risk | Artifact | Acceptance Criteria |
|---|---|---|---|---|---|---|
{rows}

## Approval gates
No high-risk actions are approved by default. Create approval records for email sends, publishing, deploys, file deletion, payments, or production changes.

## Definition of done
- Required artifacts exist.
- QA evidence is saved.
- Any incomplete work is explicitly blocked with a reason.
"""


def cmd_new_goal(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    slug = args.slug or slugify(args.goal)
    project_dir = workspace / "projects" / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    tasks = default_tasks(args.goal, slug)
    write_text(project_dir / "project-brief.md", project_brief(args.goal, slug, tasks))
    write_json(project_dir / "tasks.json", tasks)
    metadata = {"slug": slug, "goal": args.goal, "created_at": now(), "status": "created"}
    write_json(project_dir / "project.json", metadata)
    write_text(
        workspace / "logs" / "daily" / f"{datetime.now().date()}_{slug}.md",
        f"# AgentOS Project Run\n\nCreated: {now()}\n\nGoal: {args.goal}\n\nProject: `{slug}`\n",
    )
    print(json.dumps(metadata, ensure_ascii=False))
    return 0


def cmd_list_projects(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    projects = []
    for project_json in sorted((workspace / "projects").glob("*/project.json")):
        projects.append(read_json(project_json, {}))
    print(json.dumps(projects, ensure_ascii=False, indent=2))
    return 0


def approval_path(workspace: Path) -> Path:
    return workspace / "approvals" / "approvals.json"


LOW_RISK_ACTIONS = {
    "read_file",
    "write_file",
    "create_draft",
    "summarize",
    "research",
    "create_task",
    "run_test",
}

HIGH_RISK_ACTIONS = {
    "send_email",
    "mass_email",
    "publish",
    "deploy",
    "delete_file",
    "payment",
    "change_credentials",
    "production_change",
    "enable_agent_worker_daemon",
}


def classify_risk(action: str) -> dict:
    normalized = action.strip().lower().replace("-", "_")
    if normalized in HIGH_RISK_ACTIONS:
        risk = "high"
        requires = True
    elif normalized in LOW_RISK_ACTIONS:
        risk = "low"
        requires = False
    else:
        risk = "medium"
        requires = True
    return {
        "action": normalized,
        "risk": risk,
        "requires_approval": requires,
        "decision": "approval_required" if requires else "auto_allowed",
    }


def create_approval_record(workspace: Path, action: str, summary: str, risk: str) -> dict:
    approvals = read_json(approval_path(workspace), [])
    record = {
        "id": f"approval_{uuid4().hex[:10]}",
        "action": action,
        "summary": summary,
        "risk": risk,
        "status": "pending",
        "created_at": now(),
        "updated_at": now(),
    }
    approvals.append(record)
    write_json(approval_path(workspace), approvals)
    return record


def cmd_approval_create(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    record = create_approval_record(workspace, args.action, args.summary, args.risk)
    print(json.dumps(record, ensure_ascii=False))
    return 0


def update_approval(args, status: str) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    approvals = read_json(approval_path(workspace), [])
    for record in approvals:
        if record["id"] == args.id:
            record["status"] = status
            record["updated_at"] = now()
            write_json(approval_path(workspace), approvals)
            print(json.dumps(record, ensure_ascii=False))
            return 0
    print(f"approval not found: {args.id}", file=sys.stderr)
    return 1


def cmd_approval_list(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    approvals = read_json(approval_path(workspace), [])
    if args.status:
        approvals = [a for a in approvals if a.get("status") == args.status]
    print(json.dumps(approvals, ensure_ascii=False, indent=2))
    return 0


def cmd_risk_check(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    result = classify_risk(args.action)
    result["summary"] = args.summary
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_risk_request(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    result = classify_risk(args.action)
    result["summary"] = args.summary
    if not result["requires_approval"]:
        print(json.dumps(result, ensure_ascii=False))
        return 0
    approval = create_approval_record(workspace, result["action"], args.summary, result["risk"])
    print(json.dumps({"decision": "approval_created", "approval": approval}, ensure_ascii=False))
    return 0


def cmd_run_demo(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    if args.demo != "landing-page":
        print(f"unknown demo: {args.demo}", file=sys.stderr)
        return 1
    slug = "ai-seo-landing-page-demo"
    project_dir = workspace / "projects" / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    goal = "Create a verified landing page for an AI SEO agency"
    existing_metadata = read_json(project_dir / "project.json", {})
    metadata = {
        "slug": slug,
        "goal": goal,
        "created_at": existing_metadata.get("created_at") or now(),
        "status": "demo_created",
    }
    write_json(project_dir / "project.json", metadata)
    tasks = default_tasks(goal, slug)
    tasks[1]["status"] = "done"
    tasks[2]["status"] = "done"
    tasks[3]["status"] = "done"
    write_json(project_dir / "tasks.json", tasks)
    html = """<!doctype html>
<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>AI SEO Systems</title><style>body{font-family:system-ui;margin:0;background:#07111f;color:#f5f7fb;line-height:1.6}.wrap{max-width:980px;margin:auto;padding:56px 24px}.hero{padding:80px 0}.card{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:24px;padding:24px;margin:18px 0}.btn{display:inline-block;background:linear-gradient(135deg,#66e3ff,#9b7cff);color:#06101d;padding:14px 18px;border-radius:999px;font-weight:800;text-decoration:none}h1{font-size:clamp(42px,7vw,72px);line-height:.95}</style></head>
<body><main class=\"wrap\"><section class=\"hero\"><h1>AI SEO systems that turn search into a predictable growth channel</h1><p>We build practical AI-assisted SEO workflows for research, content briefs, technical checks, internal links, and monthly improvement.</p><a class=\"btn\" href=\"mailto:hello@example.com\">Book a free SEO systems audit</a></section><section class=\"card\"><h2>The problem</h2><p>Random keywords and unstructured AI drafts do not create a reliable SEO system.</p></section><section class=\"card\"><h2>The solution</h2><p>A repeatable operating workflow: audit, map, brief, publish, optimize, and review.</p></section><section class=\"card\"><h2>Services</h2><ul><li>Search opportunity research</li><li>AI-assisted content briefs</li><li>Technical SEO checks</li><li>Internal linking systems</li></ul></section></main></body></html>"""
    write_text(project_dir / "index.html", html)
    checks = {
        "file_exists": (project_dir / "index.html").exists(),
        "hero_headline": "AI SEO systems" in html,
        "cta": "Book a free SEO systems audit" in html,
        "problem": "The problem" in html,
        "solution": "The solution" in html,
        "services": "Services" in html,
        "file_size_gt_1kb": len(html.encode("utf-8")) > 1024,
    }
    result = "PASS" if all(checks.values()) else "FAIL"
    qa = "# QA Report\n\n## Result\n" + result + "\n\n## Checks\n" + "\n".join(f"- {k}: {'PASS' if v else 'FAIL'}" for k, v in checks.items()) + "\n"
    write_text(project_dir / "qa-report.md", qa)
    output = {"status": "pass" if all(checks.values()) else "fail", "slug": slug, "project_dir": str(project_dir), "checks": checks}
    print(json.dumps(output, ensure_ascii=False))
    return 0 if all(checks.values()) else 1


def workspace_summary(workspace: Path) -> dict:
    project_files = list((workspace / "projects").glob("*/project.json"))
    projects = [read_json(path, {}) for path in sorted(project_files)]
    approvals = read_json(approval_path(workspace), [])
    pending = [a for a in approvals if a.get("status") == "pending"]
    events = read_json(workspace / "logs" / "events.json", [])
    blocked_tasks = []
    for tasks_path in sorted((workspace / "projects").glob("*/tasks.json")):
        for task in read_json(tasks_path, []):
            if task.get("status") == "blocked":
                blocked_tasks.append(task)
    return {
        "workspace": str(workspace),
        "projects": len(projects),
        "project_items": projects,
        "approvals": len(approvals),
        "pending_approvals": len(pending),
        "pending_approval_items": pending,
        "blocked_tasks": len(blocked_tasks),
        "blocked_task_items": blocked_tasks,
        "events": len(events),
        "recent_events": events[-10:],
        "generated_at": now(),
    }


def render_daily_digest(summary: dict) -> str:
    project_lines = "\n".join(f"- `{p.get('slug', 'unknown')}` — {p.get('goal', 'No goal')}" for p in summary["project_items"]) or "- No projects."
    approval_lines = "\n".join(f"- `{a.get('id')}` {a.get('action')} — {a.get('summary')}" for a in summary["pending_approval_items"]) or "- No pending approvals."
    blocked_lines = "\n".join(f"- `{t.get('project')}/{t.get('id')}` — {t.get('block_reason')}" for t in summary["blocked_task_items"]) or "- No blocked tasks."
    event_lines = "\n".join(f"- {e.get('created_at')} `{e.get('type')}`" for e in summary["recent_events"][-5:]) or "- No events."
    return f"""# AgentOS Daily Digest

Generated: {summary['generated_at']}

## Counts
- Projects: {summary['projects']}
- Pending approvals: {summary['pending_approvals']}
- Blocked tasks: {summary['blocked_tasks']}
- Events: {summary['events']}

## Projects
{project_lines}

## Pending approvals
{approval_lines}

## Blocked tasks
{blocked_lines}

## Recent events
{event_lines}
"""


def cmd_digest_daily(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    summary = workspace_summary(workspace)
    if args.json_only:
        compact = {k: v for k, v in summary.items() if not k.endswith("_items") and k != "recent_events"}
        print(json.dumps(compact, ensure_ascii=False, indent=2))
        return 0
    digest_path = workspace / "logs" / "daily" / f"{datetime.now().date()}_agentos-digest.md"
    write_text(digest_path, render_daily_digest(summary))
    print(json.dumps({"status": "created", "path": str(digest_path), "generated_at": summary["generated_at"]}, ensure_ascii=False))
    return 0


def cmd_cron_template(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    if args.template != "daily-digest":
        print(f"unknown cron template: {args.template}", file=sys.stderr)
        return 1
    script_path = workspace / "scripts" / "daily_digest.py"
    instructions_path = workspace / "cron" / "daily-digest.md"
    script = f'''#!/usr/bin/env python
"""Generate an AgentOS daily digest."""
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path({str(workspace)!r})
CLI = WORKSPACE / "agentosctl.py"
subprocess.run([sys.executable, str(CLI), "--workspace", str(WORKSPACE), "digest", "daily"], check=True)
'''
    instructions = f"""# AgentOS Daily Digest Cron Template

## Purpose
Generate a daily AgentOS summary with project counts, pending approvals, blocked tasks, and recent events.

## Script

```text
{script_path}
```

## Hermes cron command

From Hermes CLI, create a daily job:

```bash
hermes cron create "0 9 * * *" --script "{script_path}" --name "AgentOS daily digest"
```

If creating through the AgentOS UI/tooling, use this script as a no-agent job or as pre-run context for a digest notification.

## Manual test

```bash
python "{script_path}"
```
"""
    write_text(script_path, script)
    write_text(instructions_path, instructions)
    print(json.dumps({"status": "created", "script": str(script_path), "instructions": str(instructions_path)}, ensure_ascii=False))
    return 0


SECRETISH_KEYS = {"api_key", "key", "token", "secret", "password"}


def deep_merge(base: dict, overlay: dict) -> dict:
    result = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


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
    return value


def load_voice_config_raw(workspace: Path) -> dict:
    load_workspace_dotenv(workspace)
    base_path = workspace / "config" / "voice.json"
    if not base_path.exists():
        base_path = DEFAULT_WORKSPACE / "config" / "voice.json"
    data = read_json(base_path, {"default_provider": "mock_text", "providers": {}})
    local_path = workspace / "config" / "voice.local.json"
    if local_path.exists():
        data = deep_merge(data, read_json(local_path, {}))
    return data


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


def voice_provider_status(name: str, cfg: dict) -> dict:
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


def voice_health(workspace: Path) -> dict:
    config = load_voice_config_raw(workspace)
    providers = [voice_provider_status(name, cfg) for name, cfg in sorted(config.get("providers", {}).items())]
    ready = sum(1 for item in providers if item["ready"])
    return {
        "status": "ok",
        "workspace": str(workspace),
        "default_provider": config.get("default_provider"),
        "summary": {"providers": len(providers), "ready": ready, "not_ready": len(providers) - ready},
        "providers": redact_secrets(providers),
    }


def command_bridge_result(workspace: Path, text: str) -> dict:
    text = text.strip()
    lower = text.lower()
    if lower.startswith("создай goal ") or lower.startswith("create goal "):
        prefix = "создай goal " if lower.startswith("создай goal ") else "create goal "
        goal = text[len(prefix):].strip()
        if not goal:
            return {"intent": "create_goal", "error": "goal_required"}
        slug = slugify(goal)
        project_dir = workspace / "projects" / slug
        project_dir.mkdir(parents=True, exist_ok=True)
        tasks = default_tasks(goal, slug)
        write_text(project_dir / "project-brief.md", project_brief(goal, slug, tasks))
        write_json(project_dir / "tasks.json", tasks)
        metadata = {"slug": slug, "goal": goal, "created_at": now(), "status": "created"}
        write_json(project_dir / "project.json", metadata)
        return {"intent": "create_goal", "text": text, "result": metadata}
    if lower in {"покажи digest", "show digest", "digest"}:
        summary = workspace_summary(workspace)
        result = {k: v for k, v in summary.items() if not k.endswith("_items") and k != "recent_events"}
        result["markdown"] = render_daily_digest(summary)
        return {"intent": "show_digest", "text": text, "result": result}
    return {"intent": "unknown", "text": text, "examples": ["создай goal ...", "покажи digest"]}


def voice_provider_test(workspace: Path, provider: str, text: str | None = None) -> dict:
    config = load_voice_config_raw(workspace)
    providers = config.get("providers", {})
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
        command = command_bridge_result(workspace, recognized)
        return {**base, "status": "passed" if command.get("intent") != "unknown" else "failed", "recognized_text": recognized, "command": command}
    if provider == "local_file":
        if not health["ready"]:
            return {**base, "status": "blocked"}
        input_file = Path(cfg.get("input_file", workspace / "voice" / "input.txt"))
        recognized = input_file.read_text(encoding="utf-8").strip()
        command = command_bridge_result(workspace, recognized)
        return {**base, "status": "passed" if command.get("intent") != "unknown" else "failed", "input_file": str(input_file), "recognized_text": recognized, "command": command}
    if provider == "gemini_live":
        if not health["ready"]:
            return {**base, "status": "blocked"}
        try:
            probe = load_voice_provider_module(workspace, provider).probe_once(cfg)
            return {**base, **redact_secrets(probe), "status": "passed", "ready": True, "reasons": ["ready"]}
        except Exception as exc:  # noqa: BLE001 - CLI boundary
            return {**base, "status": "failed", "ready": False, "reasons": ["probe_failed"], "error": str(exc)}
    if not health["ready"]:
        return {**base, "status": "blocked"}
    return {**base, "status": "blocked", "reasons": ["provider_test_not_implemented"]}


def local_file_input_path(workspace: Path) -> Path:
    config = load_voice_config_raw(workspace)
    local_file = config.get("providers", {}).get("local_file", {})
    return Path(local_file.get("input_file") or workspace / "voice" / "input.txt")


def write_voice_sample(workspace: Path, text: str) -> dict:
    sample_text = text.strip()
    if not sample_text:
        return {"status": "error", "error": "text_required"}
    input_file = local_file_input_path(workspace)
    write_text(input_file, sample_text + "\n")
    local_path = workspace / "config" / "voice.local.json"
    local = read_json(local_path, {"providers": {}})
    local.setdefault("providers", {})["local_file"] = {"enabled": True, "input_file": str(input_file)}
    write_json(local_path, local)
    return {"status": "sample_written", "provider": "local_file", "input_file": str(input_file), "text": sample_text}


def transcript_dir(workspace: Path) -> Path:
    return workspace / "voice" / "transcripts"


def write_voice_transcript(workspace: Path, result: dict) -> dict:
    entry = {
        "id": f"{datetime.utcnow().strftime('%Y%m%dT%H%M%S%f')}_{uuid4().hex[:8]}_{result.get('provider', 'unknown')}",
        "created_at": now(),
        **result,
    }
    path = transcript_dir(workspace) / f"{entry['id']}.json"
    write_json(path, entry)
    entry["path"] = str(path)
    return entry


def list_voice_transcripts(workspace: Path, limit: int = 20, provider: str | None = None, status: str | None = None, query: str | None = None) -> dict:
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
    return {"status": "ok", "items": items, "count": len(items)}


def voice_session(workspace: Path, provider: str, text: str) -> dict:
    raw_text = text.strip()
    if not raw_text:
        return {"status": "error", "error": "text_required", "provider": provider}
    config = load_voice_config_raw(workspace)
    providers = config.get("providers", {})
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
        except Exception as exc:  # noqa: BLE001 - CLI boundary
            result = {**base, "status": "failed", "error": str(exc), "reasons": ["normalize_failed"]}
            return {**result, "transcript": write_voice_transcript(workspace, result)}
        normalized_text = str(normalized.get("normalized_text", "")).strip()
        command = command_bridge_result(workspace, normalized_text)
        normalization_fallback = None
        if command.get("intent") == "unknown":
            raw_command = command_bridge_result(workspace, raw_text)
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

    command = command_bridge_result(workspace, raw_text)
    result = {**base, "normalized_text": raw_text, "command": command, "status": "passed" if command.get("intent") != "unknown" else "failed"}
    return {**result, "transcript": write_voice_transcript(workspace, result)}


def voice_loop_signature(workspace: Path, provider: str, text: str | None = None) -> dict:
    if provider == "local_file":
        input_file = local_file_input_path(workspace)
        recognized = input_file.read_text(encoding="utf-8").strip() if input_file.exists() else ""
        return {"signature": hashlib.sha256(recognized.encode("utf-8")).hexdigest(), "recognized_text": recognized}
    if provider == "mock_text":
        recognized = (text or "покажи digest").strip()
        return {"signature": hashlib.sha256(recognized.encode("utf-8")).hexdigest(), "recognized_text": recognized}
    return {"signature": provider, "recognized_text": text or ""}


def voice_loop(workspace: Path, provider: str, cycles: int = 1, interval: float = 0, text: str | None = None) -> dict:
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
    return {
        "status": "loop_completed",
        "provider": provider,
        "cycles": cycles,
        "processed": processed,
        "skipped": skipped,
        "transcripts": transcripts,
    }


def voice_loop_once(workspace: Path, provider: str, text: str | None = None) -> dict:
    return voice_loop(workspace, provider, cycles=1, interval=0, text=text)


def cmd_voice_status(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(voice_health(workspace), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_voice_test(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    result = voice_provider_test(workspace, args.provider, args.text)
    print(json.dumps(redact_secrets(result), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_voice_session(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    result = voice_session(workspace, args.provider, args.text)
    print(json.dumps(redact_secrets(result), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_voice_sample(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    result = write_voice_sample(workspace, args.text)
    if result.get("error"):
        print(result["error"], file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_voice_loop(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    if args.once:
        cycles = 1
    elif args.cycles is not None:
        cycles = args.cycles
    else:
        print("cycles_or_once_required", file=sys.stderr)
        return 1
    result = voice_loop(workspace, args.provider, cycles=cycles, interval=args.interval, text=args.text)
    if result.get("error"):
        print(result["error"], file=sys.stderr)
        return 1
    print(json.dumps(redact_secrets(result), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_voice_transcripts(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    result = list_voice_transcripts(workspace, limit=args.limit, provider=args.provider, status=args.status, query=args.query)
    print(json.dumps(redact_secrets(result), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def agent_queue_path(workspace: Path) -> Path:
    return workspace / "agents" / "queue.json"


def build_agent_queue(workspace: Path) -> list[dict]:
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
                "depends_on": deps,
                "created_at": now(),
            })
    return items


def load_agent_queue(workspace: Path) -> list[dict]:
    return read_json(agent_queue_path(workspace), [])


def save_agent_queue(workspace: Path, items: list[dict]) -> None:
    write_json(agent_queue_path(workspace), items)


def sync_agent_queue(workspace: Path) -> dict:
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
    return {"status": "synced", "count": len(items), "items": items, "path": str(agent_queue_path(workspace))}


def list_agent_queue(workspace: Path) -> dict:
    items = load_agent_queue(workspace)
    return {"status": "ok", "count": len(items), "items": items, "path": str(agent_queue_path(workspace))}


def update_agent_queue_item(workspace: Path, queue_id: str, updater) -> dict:
    items = load_agent_queue(workspace)
    for item in items:
        if item.get("queue_id") == queue_id:
            result = updater(item)
            if result.get("error"):
                return result
            save_agent_queue(workspace, items)
            return {"status": "updated", "item": item, "path": str(agent_queue_path(workspace))}
    return {"error": "queue_item_not_found", "queue_id": queue_id}


def claim_agent_queue_item(workspace: Path, queue_id: str, worker: str) -> dict:
    def updater(item: dict) -> dict:
        if item.get("status", "queued") != "queued":
            return {"error": "queue_item_not_claimable", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "claimed"
        item["claimed_by"] = worker.strip() or "unassigned"
        item["claimed_at"] = now()
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def start_agent_queue_item(workspace: Path, queue_id: str) -> dict:
    def updater(item: dict) -> dict:
        if item.get("status") != "claimed":
            return {"error": "queue_item_not_claimed", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "running"
        item["started_at"] = now()
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def lease_deadline(ttl_seconds: int | str) -> tuple[str, str]:
    ttl = max(0, int(ttl_seconds or 0))
    acquired = datetime.now().replace(microsecond=0)
    return acquired.isoformat(), (acquired + timedelta(seconds=ttl)).isoformat()


def parse_queue_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def clear_queue_lease(item: dict) -> None:
    item["lease_owner"] = None
    item["lease_acquired_at"] = None
    item["lease_expires_at"] = None
    item["heartbeat_at"] = None


def lease_agent_queue_item(workspace: Path, queue_id: str, worker: str, ttl_seconds: int | str = 300) -> dict:
    worker_name = worker.strip() or "unassigned"
    acquired_at, expires_at = lease_deadline(ttl_seconds)

    def updater(item: dict) -> dict:
        if item.get("status", "queued") != "queued":
            return {"error": "queue_item_not_leaseable", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "claimed"
        item["claimed_by"] = worker_name
        item["claimed_at"] = acquired_at
        item["lease_owner"] = worker_name
        item["lease_acquired_at"] = acquired_at
        item["heartbeat_at"] = acquired_at
        item["lease_expires_at"] = expires_at
        return {"ok": True}

    return update_agent_queue_item(workspace, queue_id, updater)


def heartbeat_agent_queue_item(workspace: Path, queue_id: str, worker: str, ttl_seconds: int | str = 300) -> dict:
    worker_name = worker.strip() or "unassigned"
    heartbeat_at, expires_at = lease_deadline(ttl_seconds)

    def updater(item: dict) -> dict:
        if item.get("status") not in {"claimed", "running"}:
            return {"error": "queue_item_not_active", "queue_id": queue_id, "current_status": item.get("status")}
        if item.get("lease_owner") != worker_name:
            return {"error": "queue_item_lease_owner_mismatch", "queue_id": queue_id, "lease_owner": item.get("lease_owner"), "worker": worker_name}
        item["heartbeat_at"] = heartbeat_at
        item["lease_expires_at"] = expires_at
        return {"ok": True}

    return update_agent_queue_item(workspace, queue_id, updater)


def requeue_stale_agent_queue_items(workspace: Path) -> dict:
    items = load_agent_queue(workspace)
    checked_at = datetime.now().replace(microsecond=0)
    changed: list[dict] = []
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
    return {"status": "requeued_stale", "checked_at": checked_at.isoformat(), "requeued": len(changed), "items": changed, "path": str(agent_queue_path(workspace))}


def attach_task_artifact(workspace: Path, project: str, task_id: str, artifact_path: str, status: str | None = None, executor: str | None = None, result_summary: str | None = None, log_path: str | None = None) -> None:
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


def write_agent_queue_log(workspace: Path, item: dict, worker: str, state: str, extra: str = "") -> str:
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


def load_agent_queue_runs(workspace: Path) -> list[dict]:
    return read_json(agent_queue_runs_path(workspace), [])


def append_agent_queue_run(workspace: Path, item: dict, worker: str, trigger: str, filters: dict | None = None, execution_context: dict | None = None) -> dict:
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


def list_agent_queue_runs(workspace: Path, limit: int | str = 20) -> dict:
    runs = list(reversed(load_agent_queue_runs(workspace)))
    limit_int = int(limit or 20)
    visible = runs[:limit_int] if limit_int > 0 else runs
    return {"status": "ok", "count": len(runs), "runs": visible, "path": str(agent_queue_runs_path(workspace))}


def write_agent_queue_artifact(workspace: Path, item: dict, worker: str) -> tuple[str, str, str]:
    project_meta = read_json(workspace / "projects" / str(item.get("project")) / "project.json", {})
    stamp = datetime.now().strftime('%Y%m%dT%H%M%S')
    artifact_path = workspace / "artifacts" / "agent-queue" / str(item.get("project")) / f"{item.get('task_id')}_{stamp}.md"
    summary = f"Executed locally by {worker}: {item.get('objective')}"
    content = "\n".join([
        f"# Agent Queue Execution — {item.get('project')}/{item.get('task_id')}",
        "",
        f"Goal: {project_meta.get('goal', 'Unknown goal')}",
        f"Worker: {worker}",
        f"Queue ID: {item.get('queue_id')}",
        f"Executed at: {now()}",
        "",
        "## Objective",
        str(item.get('objective') or ''),
        "",
        "## Result summary",
        summary,
        "",
        "## Acceptance",
        "- Local execution artifact saved.",
        "- Queue item moved to done.",
    ]) + "\n"
    write_text(artifact_path, content)
    log_path = write_agent_queue_log(workspace, item, worker, "completed", summary)
    return str(artifact_path), summary, log_path


def fail_agent_queue_item(workspace: Path, queue_id: str, reason: str) -> dict:
    def updater(item: dict) -> dict:
        if item.get("status") not in {"claimed", "running"}:
            return {"error": "queue_item_not_active", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "failed"
        item["failed_at"] = now()
        item["last_error"] = reason.strip() or "execution failed"
        item["completed_at"] = None
        clear_queue_lease(item)
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def retry_agent_queue_item(workspace: Path, queue_id: str) -> dict:
    def updater(item: dict) -> dict:
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
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def cancel_agent_queue_item(workspace: Path, queue_id: str, reason: str) -> dict:
    def updater(item: dict) -> dict:
        if item.get("status") in {"done", "cancelled"}:
            return {"error": "queue_item_not_cancellable", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "cancelled"
        item["cancel_reason"] = reason.strip() or "cancelled"
        item["cancelled_at"] = now()
        clear_queue_lease(item)
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def complete_agent_queue_item(workspace: Path, queue_id: str) -> dict:
    def updater(item: dict) -> dict:
        if item.get("status") != "running":
            return {"error": "queue_item_not_running", "queue_id": queue_id, "current_status": item.get("status")}
        item["status"] = "done"
        item["completed_at"] = now()
        clear_queue_lease(item)
        artifact_path = (item.get("artifacts") or [""])[0]
        attach_task_artifact(
            workspace,
            item.get("project"),
            item.get("task_id"),
            artifact_path,
            status="done",
            executor=item.get("executor"),
            result_summary=item.get("result_summary"),
            log_path=item.get("log_path"),
        )
        return {"ok": True}
    return update_agent_queue_item(workspace, queue_id, updater)


def execute_agent_queue_item(workspace: Path, queue_id: str, worker: str) -> dict:
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


def run_next_agent_queue_item(workspace: Path, worker: str, ttl_seconds: int | str = 300, queue_id: str | None = None, project: str | None = None, owner: str | None = None, execution_context: dict | None = None) -> dict:
    sync_agent_queue(workspace)
    queue = list_agent_queue(workspace).get("items", [])
    filters = {
        "queue_id": (queue_id or "").strip() or None,
        "project": (project or "").strip() or None,
        "owner": (owner or "").strip() or None,
    }

    def matches_filters(candidate: dict) -> bool:
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
    return completed


def run_batch_agent_queue_items(workspace: Path, worker: str, max_items: int | str = 1, ttl_seconds: int | str = 300, dry_run: bool = False, queue_id: str | None = None, project: str | None = None, owner: str | None = None, execution_context: dict | None = None) -> dict:
    sync_agent_queue(workspace)
    queue = list_agent_queue(workspace).get("items", [])
    limit = max(1, int(max_items or 1))
    filters = {
        "queue_id": (queue_id or "").strip() or None,
        "project": (project or "").strip() or None,
        "owner": (owner or "").strip() or None,
    }

    def matches_filters(candidate: dict) -> bool:
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
        return {
            "status": "dry_run" if planned_items else "empty",
            "dry_run": True,
            "planned": len(planned_items),
            "executed": 0,
            "max_items": limit,
            "filters": filters,
            "items": planned_items,
            "results": [],
            "path": str(agent_queue_path(workspace)),
        }
    if not planned_items:
        return {
            "status": "empty",
            "dry_run": False,
            "planned": 0,
            "executed": 0,
            "max_items": limit,
            "filters": filters,
            "items": [],
            "results": [],
            "path": str(agent_queue_path(workspace)),
        }

    results: list[dict] = []
    executed_items: list[dict] = []
    for _planned in planned_items:
        result = run_next_agent_queue_item(workspace, worker, ttl_seconds, queue_id, project, owner, execution_context)
        results.append(result)
        if result.get("error"):
            return {
                "status": "error",
                "dry_run": False,
                "planned": len(planned_items),
                "executed": len(executed_items),
                "max_items": limit,
                "filters": filters,
                "items": executed_items,
                "results": results,
                "error": result,
                "path": str(agent_queue_path(workspace)),
            }
        if result.get("status") != "executed_next" or not result.get("item"):
            break
        executed_items.append(result["item"])
    return {
        "status": "executed_batch" if executed_items else "empty",
        "dry_run": False,
        "planned": len(planned_items),
        "executed": len(executed_items),
        "max_items": limit,
        "filters": filters,
        "items": executed_items,
        "results": results,
        "path": str(agent_queue_path(workspace)),
    }


def agent_worker_config_path(workspace: Path) -> Path:
    return workspace / "config" / "agent-worker.json"


def default_agent_worker_config() -> dict:
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


def normalize_agent_worker_config(raw: dict | None) -> dict:
    config = default_agent_worker_config()
    raw = raw or {}
    extra_keys = [
        "version",
        "enabled",
        "mode",
        "worker",
        "max_items_per_tick",
        "ttl_seconds",
        "interval_seconds",
        "preview_ttl_seconds",
        "dry_run",
        "runtime_mode",
        "requires_approval",
        "approval_action",
        "updated_at",
        "enable_approval_id",
        "enable_requested_at",
        "enabled_by_approval",
        "enabled_at",
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


def load_agent_worker_config(workspace: Path) -> dict:
    path = agent_worker_config_path(workspace)
    config = normalize_agent_worker_config(read_json(path, {}))
    if not path.exists():
        write_json(path, config)
    return config


def save_agent_worker_config(workspace: Path, updates: dict) -> dict:
    config = normalize_agent_worker_config(load_agent_worker_config(workspace))
    # This wave is a preview/stub only: keep the future daemon disabled until an explicit approval flow exists.
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
    return config


def agent_worker_runtime_config_state(config: dict) -> dict:
    mode = normalize_agent_worker_config(config).get("runtime_mode", "dry_run")
    if mode == "execute":
        guard = "requires_approval_and_execute_mode"
        description = "Manual runtime may execute bounded local queue items only after approved enable_agent_worker_daemon approval."
    else:
        guard = "dry_run_default"
        description = "Manual runtime remains dry-run/audit-only by default."
    return {"mode": mode, "dry_run": mode != "execute", "execution_guard": guard, "description": description}


def find_agent_worker_enable_approvals(workspace: Path):
    approvals = read_json(approval_path(workspace), [])
    return [approval for approval in approvals if approval.get("action") == "enable_agent_worker_daemon"]


def agent_worker_approval_state(workspace: Path, config: dict | None = None) -> dict:
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


def request_agent_worker_enable(workspace: Path, summary: str | None = None) -> dict:
    config = load_agent_worker_config(workspace)
    filters = config.get("filters") or {}
    if not summary:
        summary = (
            f"Enable AgentOS worker daemon preview for worker={config.get('worker')} "
            f"max_items_per_tick={config.get('max_items_per_tick')} "
            f"filters(project={filters.get('project') or 'any'}, owner={filters.get('owner') or 'any'}, queue_id={filters.get('queue_id') or 'any'})"
        )
    approval = create_approval_record(workspace, "enable_agent_worker_daemon", summary, "high")
    config["enabled"] = False
    config["enable_approval_id"] = approval["id"]
    config["enable_requested_at"] = now()
    config["updated_at"] = now()
    config = normalize_agent_worker_config(config)
    write_json(agent_worker_config_path(workspace), config)
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


def enable_agent_worker_with_approval(workspace: Path, approval_id: str) -> dict:
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


def agent_worker_status(workspace: Path) -> dict:
    config = load_agent_worker_config(workspace)
    enabled = bool(config.get("enabled"))
    return {
        "status": "enabled_preview_only" if enabled else "disabled",
        "will_execute": False,
        "scheduler": {
            "enabled": False,
            "mode": "approved_but_runtime_not_started" if enabled else "disabled_by_default",
            "reason": "worker daemon runtime is approval-gated and no scheduler is started",
        },
        "approval": agent_worker_approval_state(workspace, config),
        "runtime": agent_worker_runtime_config_state(config),
        "config": config,
        "path": str(agent_worker_config_path(workspace)),
    }


def agent_worker_tick(workspace: Path, preview: bool = False) -> dict:
    config = load_agent_worker_config(workspace)
    if not preview:
        enabled = bool(config.get("enabled"))
        return {
            "status": "runtime_not_started" if enabled else "disabled",
            "will_execute": False,
            "executed": 0,
            "planned": 0,
            "reason": "worker daemon runtime is not started; use preview for a non-executing dry-run",
            "approval": agent_worker_approval_state(workspace, config),
            "config": config,
            "path": str(agent_worker_config_path(workspace)),
        }
    filters = config.get("filters") or {}
    result = run_batch_agent_queue_items(
        workspace,
        str(config.get("worker") or "dashboard-agent"),
        config.get("max_items_per_tick", 1),
        config.get("ttl_seconds", 300),
        True,
        filters.get("queue_id"),
        filters.get("project"),
        filters.get("owner"),
    )
    result["status"] = "preview" if result.get("planned") else "empty"
    result["will_execute"] = False
    result["config"] = config
    result["scheduler"] = {"enabled": False, "mode": "preview_tick"}
    return result


def agent_worker_runtime_audits_path(workspace: Path) -> Path:
    return workspace / "logs" / "agent-worker" / "runtime-ticks.json"


def load_agent_worker_runtime_audits(workspace: Path) -> list:
    return read_json(agent_worker_runtime_audits_path(workspace), [])


def append_agent_worker_runtime_audit(workspace: Path, record: dict) -> dict:
    audits = load_agent_worker_runtime_audits(workspace)
    audits.append(record)
    write_json(agent_worker_runtime_audits_path(workspace), audits)
    return record


def list_agent_worker_runtime_audits(workspace: Path, limit: int | str = 20) -> dict:
    audits = list(reversed(load_agent_worker_runtime_audits(workspace)))
    limit_int = int(limit or 20)
    visible = audits[:limit_int] if limit_int > 0 else audits
    return {"count": len(visible), "total": len(audits), "audits": visible, "path": str(agent_worker_runtime_audits_path(workspace))}


def agent_worker_runtime_previews_path(workspace: Path) -> Path:
    return workspace / "logs" / "agent-worker" / "runtime-previews.json"


def load_agent_worker_runtime_previews(workspace: Path) -> list:
    return read_json(agent_worker_runtime_previews_path(workspace), [])


def append_agent_worker_runtime_preview(workspace: Path, record: dict) -> dict:
    previews = load_agent_worker_runtime_previews(workspace)
    previews.append(record)
    write_json(agent_worker_runtime_previews_path(workspace), previews)
    return record


def update_agent_worker_runtime_preview(workspace: Path, preview_id: str, updates: dict) -> dict | None:
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


def normalize_agent_worker_runtime_preview_status(status: str | None) -> str | None:
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


def agent_worker_runtime_preview_token_status(preview: dict) -> str:
    status = normalize_agent_worker_runtime_preview_status(preview.get("token_status"))
    if status:
        return status
    execution_status = normalize_agent_worker_runtime_preview_status(preview.get("execution_status"))
    return execution_status or "unknown"


def summarize_agent_worker_runtime_previews(previews: list[dict]) -> dict:
    summary = {"total": len(previews), "pending": 0, "consumed": 0, "expired": 0, "revoked": 0, "not_required": 0, "unknown": 0}
    for preview in previews:
        status = agent_worker_runtime_preview_token_status(preview)
        if status not in summary:
            status = "unknown"
        summary[status] += 1
    return summary


def list_agent_worker_runtime_previews(workspace: Path, limit: int | str = 20, status: str | None = None) -> dict:
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


def expire_stale_agent_worker_runtime_previews(workspace: Path) -> dict:
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
        preview.update({
            "token_status": "expired",
            "execution_status": "expired",
            "expired_at": now(),
            "confirmation": confirmation,
        })
        expired.append(preview)
    if expired:
        write_json(agent_worker_runtime_previews_path(workspace), previews)
    return {
        "status": "runtime_previews_expired",
        "scanned": len(previews),
        "expired": len(expired),
        "expired_preview_ids": [preview.get("preview_id") or preview.get("id") for preview in expired],
        "previews": expired,
        "path": str(agent_worker_runtime_previews_path(workspace)),
    }


def find_agent_worker_runtime_preview_by_token(workspace: Path, token: str | None) -> dict | None:
    if not token:
        return None
    for preview in reversed(load_agent_worker_runtime_previews(workspace)):
        confirmation = preview.get("confirmation") or {}
        if confirmation.get("token") == token:
            return preview
    return None


def find_agent_worker_runtime_preview(workspace: Path, preview_id: str | None = None, confirmation_token: str | None = None) -> dict | None:
    if preview_id:
        for preview in reversed(load_agent_worker_runtime_previews(workspace)):
            if preview.get("preview_id") == preview_id or preview.get("id") == preview_id:
                return preview
    return find_agent_worker_runtime_preview_by_token(workspace, confirmation_token)


def agent_worker_runtime_preview_detail(workspace: Path, preview_id: str | None = None, confirmation_token: str | None = None) -> dict:
    preview = find_agent_worker_runtime_preview(workspace, preview_id, confirmation_token)
    if not preview:
        return {"status": "runtime_preview_not_found", "error": "runtime_preview_not_found", "preview_id": preview_id, "confirmation_token": confirmation_token, "preview": None, "path": str(agent_worker_runtime_previews_path(workspace))}
    token_status = agent_worker_runtime_preview_token_status(preview)
    return {"status": "runtime_preview_found", "preview_id": preview.get("preview_id") or preview.get("id"), "one_shot_run_id": preview.get("one_shot_run_id"), "token_status": token_status, "execution_status": preview.get("execution_status"), "preview": preview, "path": str(agent_worker_runtime_previews_path(workspace))}


def agent_worker_runtime_confirmation_preflight(workspace: Path, confirmation_token: str | None = None, preview_id: str | None = None) -> dict:
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


def agent_worker_runtime_preview_expires_at(created_at: str | None = None, ttl_seconds: int | str = 900) -> str:
    base = datetime.fromisoformat(created_at) if created_at else datetime.now().replace(microsecond=0)
    return (base + timedelta(seconds=max(1, int(ttl_seconds or 900)))).replace(microsecond=0).isoformat()


def agent_worker_runtime_preview_is_expired(preview: dict) -> bool:
    expires_at = preview.get("expires_at")
    if not expires_at:
        return False
    try:
        return datetime.fromisoformat(str(expires_at)) <= datetime.now().replace(microsecond=0)
    except ValueError:
        return False


def agent_worker_runtime_reject_confirmation(workspace: Path, preview: dict, status: str, reason: str, confirmation_reason: str, runtime: dict, config: dict, approval_state: dict, scheduler: dict, mutate_preview: bool = False) -> dict:
    confirmation = dict(preview.get("confirmation") or {})
    confirmation["accepted"] = False
    confirmation["reason"] = confirmation_reason
    updates = None
    if mutate_preview:
        token_status = "expired" if confirmation_reason == "token_expired" else "revoked" if confirmation_reason == "token_revoked" else "consumed"
        updates = {"token_status": token_status, "execution_status": token_status, "confirmation": confirmation}
        if token_status == "expired":
            updates["expired_at"] = now()
        update_agent_worker_runtime_preview(workspace, preview.get("preview_id"), updates)
        preview = dict(preview)
        preview.update(updates)
    return {
        "status": status,
        "decision": "confirmation_rejected",
        "reason": reason,
        "runtime_mode": runtime["mode"],
        "dry_run": True,
        "will_execute": False,
        "planned": preview.get("planned", 0),
        "executed": 0,
        "max_items": preview.get("max_items"),
        "filters": preview.get("filters", {}),
        "items": preview.get("items", []),
        "queue_ids": preview.get("queue_ids", []),
        "results": preview.get("results", []),
        "preview": preview,
        "preview_id": preview.get("preview_id"),
        "one_shot_run_id": preview.get("one_shot_run_id"),
        "token_status": preview.get("token_status"),
        "expires_at": preview.get("expires_at"),
        "audit": None,
        "confirmation": confirmation,
        "execution_policy": preview.get("execution_policy"),
        "approval": approval_state,
        "runtime": runtime,
        "scheduler": scheduler,
        "config": config,
        "path": str(agent_worker_runtime_audits_path(workspace)),
    }


def revoke_agent_worker_runtime_preview(workspace: Path, preview_id: str | None = None, confirmation_token: str | None = None, reason: str | None = None) -> dict:
    preview = find_agent_worker_runtime_preview(workspace, preview_id, confirmation_token)
    if not preview:
        return {"status": "runtime_preview_not_found", "error": "runtime_preview_not_found", "preview_id": preview_id, "confirmation_token": confirmation_token, "path": str(agent_worker_runtime_previews_path(workspace))}
    confirmation = dict(preview.get("confirmation") or {})
    confirmation["accepted"] = False
    confirmation["reason"] = "token_revoked"
    updates = {
        "token_status": "revoked",
        "execution_status": "revoked",
        "revoked_at": now(),
        "revocation_reason": reason or "operator_revoked",
        "confirmation": confirmation,
    }
    updated = update_agent_worker_runtime_preview(workspace, preview.get("preview_id"), updates) or dict(preview, **updates)
    return {"status": "runtime_preview_revoked", "decision": "confirmation_revoked", "preview_id": updated.get("preview_id"), "one_shot_run_id": updated.get("one_shot_run_id"), "token_status": updated.get("token_status"), "execution_status": updated.get("execution_status"), "revocation_reason": updated.get("revocation_reason"), "confirmation": updated.get("confirmation"), "preview": updated, "path": str(agent_worker_runtime_previews_path(workspace))}


def approved_agent_worker_enable(workspace: Path, config: dict) -> dict | None:
    approval_id = config.get("enabled_by_approval") or config.get("enable_approval_id")
    if not (bool(config.get("enabled")) and approval_id):
        return None
    approval = next((item for item in find_agent_worker_enable_approvals(workspace) if item.get("id") == approval_id), None)
    if approval and approval.get("status") == "approved":
        return approval
    return None


def agent_worker_runtime_queue_ids(result: dict) -> list[str]:
    return [str(item.get("queue_id")) for item in result.get("items", []) if item.get("queue_id")]


def agent_worker_runtime_execution_policy(runtime: dict, config: dict) -> dict:
    return {
        "manual_only": True,
        "scheduler_enabled": False,
        "scheduler_mode": "disabled",
        "approval_required": True,
        "confirmation_required": runtime.get("mode") == "execute",
        "bounded": True,
        "max_items_per_tick": config.get("max_items_per_tick"),
        "preview_ttl_seconds": config.get("preview_ttl_seconds"),
        "runtime_mode": runtime.get("mode"),
        "dry_run": runtime.get("mode") != "execute",
    }


def agent_worker_runtime_confirmation_token(config: dict, approval: dict, result: dict, preview_id: str | None = None, one_shot_run_id: str | None = None) -> str:
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


def agent_worker_runtime_confirmation(runtime: dict, config: dict, approval: dict | None, result: dict, accepted: bool = False, reason: str | None = None, preview_id: str | None = None, one_shot_run_id: str | None = None) -> dict:
    required = runtime.get("mode") == "execute"
    token = agent_worker_runtime_confirmation_token(config, approval or {}, result, preview_id, one_shot_run_id) if required and approval else None
    confirmation = {
        "required": required,
        "accepted": bool(accepted),
        "token": token,
        "confirm_execute_arg": "--confirm-execute",
        "api_field": "confirmation_token",
        "api_confirm_field": "confirm_execute",
    }
    if reason:
        confirmation["reason"] = reason
    return confirmation


def agent_worker_runtime_preview(workspace: Path) -> dict:
    config = load_agent_worker_config(workspace)
    runtime = agent_worker_runtime_config_state(config)
    approval = approved_agent_worker_enable(workspace, config)
    approval_state = agent_worker_approval_state(workspace, config)
    dry_run = True
    scheduler = {"enabled": False, "mode": "manual_runtime_preview"}
    if not approval:
        return {
            "status": "approval_required",
            "decision": "approval_required",
            "reason": "approved enable_agent_worker_daemon approval required before runtime preview",
            "runtime_mode": runtime["mode"],
            "dry_run": dry_run,
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
            "path": str(agent_worker_runtime_previews_path(workspace)),
        }
    filters = config.get("filters") or {}
    result = run_batch_agent_queue_items(
        workspace,
        str(config.get("worker") or "dashboard-agent"),
        config.get("max_items_per_tick", 1),
        config.get("ttl_seconds", 300),
        True,
        filters.get("queue_id"),
        filters.get("project"),
        filters.get("owner"),
    )
    status = "runtime_execute_preview" if runtime["mode"] == "execute" else "runtime_dry_run_preview"
    preview_id = f"runtime_preview_{uuid4().hex[:10]}"
    one_shot_run_id = f"runtime_once_{uuid4().hex[:10]}"
    created_at = now()
    expires_at = agent_worker_runtime_preview_expires_at(created_at, config.get("preview_ttl_seconds", 900))
    confirmation = agent_worker_runtime_confirmation(runtime, config, approval, result, preview_id=preview_id, one_shot_run_id=one_shot_run_id)
    execution_policy = agent_worker_runtime_execution_policy(runtime, config)
    record = {
        "id": preview_id,
        "preview_id": preview_id,
        "one_shot_run_id": one_shot_run_id,
        "status": status,
        "execution_status": "pending_confirmation" if runtime["mode"] == "execute" else "dry_run_preview",
        "token_status": "pending" if runtime["mode"] == "execute" else "not_required",
        "created_at": created_at,
        "expires_at": expires_at,
        "worker": config.get("worker"),
        "approval_id": approval.get("id"),
        "runtime_mode": runtime["mode"],
        "dry_run": dry_run,
        "will_execute": False,
        "planned": result.get("planned", 0),
        "executed": 0,
        "max_items": result.get("max_items"),
        "filters": result.get("filters", {}),
        "items": result.get("items", []),
        "queue_ids": agent_worker_runtime_queue_ids(result),
        "results": result.get("results", []),
        "audit": None,
        "confirmation": confirmation,
        "execution_policy": execution_policy,
        "approval": approval_state,
        "runtime": runtime,
        "scheduler": scheduler,
        "config": config,
        "path": str(agent_worker_runtime_previews_path(workspace)),
    }
    append_agent_worker_runtime_preview(workspace, record)
    return record


def agent_worker_runtime_tick(workspace: Path, confirm_execute: bool = False, confirmation_token: str | None = None) -> dict:
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
            "audit": None,
            "confirmation": {"required": runtime.get("mode") == "execute", "accepted": False, "token": None, "confirm_execute_arg": "--confirm-execute", "api_field": "confirmation_token", "api_confirm_field": "confirm_execute"},
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
            return {
                "status": "execute_confirmation_required",
                "decision": "confirmation_required",
                "reason": "execute runtime_mode requires explicit operator confirmation",
                "runtime_mode": runtime["mode"],
                "dry_run": True,
                "will_execute": False,
                "planned": preview.get("planned", 0),
                "executed": 0,
                "max_items": preview.get("max_items"),
                "filters": preview.get("filters", {}),
                "items": preview.get("items", []),
                "queue_ids": preview.get("queue_ids", []),
                "results": preview.get("results", []),
                "preview": preview,
                "preview_id": preview.get("preview_id"),
                "one_shot_run_id": preview.get("one_shot_run_id"),
                "audit": None,
                "confirmation": confirmation,
                "execution_policy": preview.get("execution_policy"),
                "approval": approval_state,
                "runtime": runtime,
                "scheduler": scheduler,
                "config": config,
                "path": str(agent_worker_runtime_audits_path(workspace)),
            }
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
        execution_context = {
            "runtime_preview_id": preview_record.get("preview_id"),
            "one_shot_run_id": preview_record.get("one_shot_run_id"),
            "confirmation_token": confirmation_token,
            "execution_policy": preview_record.get("execution_policy"),
        }
    result = run_batch_agent_queue_items(
        workspace,
        str(config.get("worker") or "dashboard-agent"),
        config.get("max_items_per_tick", 1),
        config.get("ttl_seconds", 300),
        dry_run,
        filters.get("queue_id"),
        filters.get("project"),
        filters.get("owner"),
        execution_context,
    )
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


def cmd_agent_queue_sync(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(sync_agent_queue(workspace), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_list(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(list_agent_queue(workspace), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_claim(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(claim_agent_queue_item(workspace, args.queue_id, args.worker), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_start(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(start_agent_queue_item(workspace, args.queue_id), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_lease(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(lease_agent_queue_item(workspace, args.queue_id, args.worker, args.ttl_seconds), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_heartbeat(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(heartbeat_agent_queue_item(workspace, args.queue_id, args.worker, args.ttl_seconds), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_requeue_stale(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(requeue_stale_agent_queue_items(workspace), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_fail(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(fail_agent_queue_item(workspace, args.queue_id, args.reason), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_retry(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(retry_agent_queue_item(workspace, args.queue_id), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_cancel(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(cancel_agent_queue_item(workspace, args.queue_id, args.reason), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_complete(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(complete_agent_queue_item(workspace, args.queue_id), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_execute(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(execute_agent_queue_item(workspace, args.queue_id, args.worker), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_run_next(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(run_next_agent_queue_item(workspace, args.worker, args.ttl_seconds, args.queue_id, args.project, args.owner), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_runs(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(list_agent_queue_runs(workspace, args.limit), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_queue_run_batch(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(run_batch_agent_queue_items(workspace, args.worker, args.max_items, args.ttl_seconds, args.dry_run, args.queue_id, args.project, args.owner), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_status(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(agent_worker_status(workspace), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_configure(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    updates = {
        "worker": args.worker,
        "max_items_per_tick": args.max_items_per_tick,
        "ttl_seconds": args.ttl_seconds,
        "interval_seconds": args.interval_seconds,
        "preview_ttl_seconds": args.preview_ttl_seconds,
        "dry_run": args.dry_run,
        "runtime_mode": args.runtime_mode,
        "queue_id": args.queue_id,
        "project": args.project,
        "owner": args.owner,
    }
    config = save_agent_worker_config(workspace, updates)
    print(json.dumps({"status": "configured", "will_execute": False, "runtime": agent_worker_runtime_config_state(config), "config": config, "path": str(agent_worker_config_path(workspace))}, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_tick(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(agent_worker_tick(workspace, preview=args.preview), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_request_enable(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(request_agent_worker_enable(workspace, args.summary), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_enable(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(enable_agent_worker_with_approval(workspace, args.approval_id), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_runtime_tick(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(agent_worker_runtime_tick(workspace, confirm_execute=args.confirm_execute, confirmation_token=args.confirmation_token), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_runtime_preview(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(agent_worker_runtime_preview(workspace), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_runtime_preview_revoke(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(revoke_agent_worker_runtime_preview(workspace, args.preview_id, args.confirmation_token, args.reason), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_runtime_preview_expire_stale(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(expire_stale_agent_worker_runtime_previews(workspace), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_runtime_preview_detail(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(agent_worker_runtime_preview_detail(workspace, args.preview_id, args.confirmation_token), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_runtime_preview_validate_token(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(agent_worker_runtime_confirmation_preflight(workspace, args.confirmation_token, args.preview_id), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_runtime_previews(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(list_agent_worker_runtime_previews(workspace, args.limit, args.status), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_agent_worker_runtime_audits(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    print(json.dumps(list_agent_worker_runtime_audits(workspace, args.limit), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def release_check(workspace: Path) -> dict:
    backend = workspace / "dashboard" / "backend" / "app.py"
    frontend = workspace / "dashboard" / "frontend" / "index.html"
    cli = workspace / "agentosctl.py"
    reports = list((workspace / "logs" / "daily").glob("*_agentos-wave-*.md"))
    def report_key(path: Path):
        match = re.search(r"wave-(\d+)-report\.md$", path.name)
        return int(match.group(1)) if match else -1
    reports.sort(key=report_key)
    backend_text = read_text(backend, "")
    frontend_text = read_text(frontend, "")
    cli_text = read_text(cli, "")
    checks = {
        "workspace": workspace.exists(),
        "dashboard_backend": backend.exists(),
        "dashboard_frontend": frontend.exists(),
        "command_bridge": "/api/command" in backend_text and "Command Bridge" in frontend_text,
        "voice_loop": "def voice_loop" in cli_text and "/api/voice-loop" in backend_text,
        "transcript_filters": "voiceTranscriptProvider" in frontend_text and "voice transcripts" in cli_text.lower(),
        "approval_gate": "approval_required" in backend_text and "create_real_kanban_tasks" in backend_text,
        "mila_realtime_ux": "milaRealtimePanel" in frontend_text and "milaStartListening" in frontend_text and "/api/voice-session" in frontend_text,
        "mila_desktop_packaging": all((workspace / rel).exists() for rel in ["scripts/start_mila.bat", "scripts/start_mila.sh", "installers/install_mila_autostart.bat", "installers/uninstall_mila_autostart.bat"]),
        "mila_agentic_os_interface": "agenticOsShell" in frontend_text and "milaMemoryGalaxy" in frontend_text and "milaAppBuilder" in frontend_text,
        "mila_dashboard_routes": "milaPrimaryRoutes" in frontend_text and "activateMilaRoute" in frontend_text and "syncMilaRouteFromHash" in frontend_text,
        "mila_agent_dock_live": "milaAgentDockLive" in frontend_text and "loadMilaAgentDock" in frontend_text,
        "mila_memory_galaxy_live": "milaMemoryGalaxyLive" in frontend_text and "loadMilaMemoryGalaxy" in frontend_text,
        "mila_app_builder_functional": "milaAppBuilderIdea" in frontend_text and "loadMilaAppBuilderBlueprint" in frontend_text,
        "mila_kanban_studio_live": "milaKanbanStudioLive" in frontend_text and "loadMilaKanbanStudio" in frontend_text,
        "mila_model_hub_live": "milaModelHubLive" in frontend_text and "loadMilaModelHub" in frontend_text,
        "mila_native_tray_scaffold": all((workspace / rel).exists() for rel in ["scripts/mila_tray.py", "scripts/start_mila_tray.bat"]) and "milaTrayPackagePanel" in frontend_text and "loadMilaTrayPackage" in frontend_text,
        "mila_visual_polish_final": "milaJarvisWorkspace" in frontend_text and "jarvis-focus-strip" in frontend_text and "loadMilaVisualPolish" in frontend_text,
        "latest_report": bool(reports),
    }
    optional_blockers = []
    voice = load_voice_config_raw(workspace)
    gemini = voice.get("providers", {}).get("gemini_live", {})
    gemini_status = voice_provider_status("gemini_live", gemini) if gemini else {"ready": False, "reasons": ["not_configured"]}
    if not gemini_status.get("ready"):
        optional_blockers.append("gemini_live")
    status = "ready_local" if all(checks.values()) else "needs_attention"
    return {
        "status": status,
        "dashboard_url": "http://127.0.0.1:8765/",
        "workspace": str(workspace),
        "checks": checks,
        "optional_blockers": optional_blockers,
        "gemini_live": gemini_status,
        "latest_report": str(reports[-1]) if reports else None,
    }


def cmd_release_check(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    result = release_check(workspace)
    print(json.dumps(redact_secrets(result), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


def cmd_kanban_export(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    project_dir = workspace / "projects" / args.slug
    project = read_json(project_dir / "project.json", {})
    tasks = read_json(project_dir / "tasks.json", [])
    if not project or not tasks:
        print(f"project not found or has no tasks: {args.slug}", file=sys.stderr)
        return 1
    export = {
        "project": args.slug,
        "goal": project.get("goal"),
        "tasks": [
            {
                "title": f"{task.get('id')}: {task.get('objective')}",
                "body": "\n".join([
                    f"Project: {args.slug}",
                    f"Owner: {task.get('owner')}",
                    f"Risk: {task.get('risk_level')}",
                    f"Depends on: {', '.join(task.get('depends_on') or []) or 'none'}",
                    "Acceptance criteria:",
                    *[f"- {c}" for c in task.get('acceptance_criteria', [])],
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
    json_path = out_dir / f"{args.slug}.json"
    md_path = out_dir / f"{args.slug}.md"
    write_json(json_path, export)
    lines = [f"# Hermes Kanban Export: {args.slug}", "", "## Goal", str(project.get("goal", "")), "", "## Commands", ""]
    for task in export["tasks"]:
        title = task["title"].replace('"', "'")
        body = task["body"].replace('"', "'")
        lines.append(f"```bash\nhermes kanban create --title \"{title}\" --assignee \"{task['assignee']}\" --body \"{body}\"\n```")
    write_text(md_path, "\n".join(lines) + "\n")
    print(json.dumps({"status": "created", "json": str(json_path), "markdown": str(md_path)}, ensure_ascii=False))
    return 0


def cmd_command(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    text = args.text.strip()
    lower = text.lower()
    if lower.startswith("создай goal ") or lower.startswith("create goal "):
        prefix = "создай goal " if lower.startswith("создай goal ") else "create goal "
        goal = text[len(prefix):].strip()
        if not goal:
            print(json.dumps({"intent": "create_goal", "error": "goal_required"}, ensure_ascii=False))
            return 1
        slug = slugify(goal)
        class GoalArgs:
            pass
        goal_args = GoalArgs()
        goal_args.workspace = str(workspace)
        goal_args.goal = goal
        goal_args.slug = slug
        # inline instead of calling cmd_new_goal to avoid double-print
        project_dir = workspace / "projects" / slug
        project_dir.mkdir(parents=True, exist_ok=True)
        tasks = default_tasks(goal, slug)
        write_text(project_dir / "project-brief.md", project_brief(goal, slug, tasks))
        write_json(project_dir / "tasks.json", tasks)
        metadata = {"slug": slug, "goal": goal, "created_at": now(), "status": "created"}
        write_json(project_dir / "project.json", metadata)
        print(json.dumps({"intent": "create_goal", "text": text, "result": metadata}, ensure_ascii=False))
        return 0
    if lower in {"покажи digest", "show digest", "digest"}:
        summary = workspace_summary(workspace)
        result = {k: v for k, v in summary.items() if not k.endswith("_items") and k != "recent_events"}
        result["markdown"] = render_daily_digest(summary)
        print(json.dumps({"intent": "show_digest", "text": text, "result": result}, ensure_ascii=False))
        return 0
    print(json.dumps({"intent": "unknown", "text": text, "examples": ["создай goal ...", "покажи digest"]}, ensure_ascii=False))
    return 0


def cmd_report(args) -> int:
    workspace = workspace_from_args(args)
    ensure_workspace(workspace)
    summary = workspace_summary(workspace)
    report = {k: v for k, v in summary.items() if not k.endswith("_items") and k != "recent_events"}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Control a local AgentOS workspace")
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE), help="AgentOS workspace path")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init")
    p_init.set_defaults(func=cmd_init)

    p_goal = sub.add_parser("new-goal")
    p_goal.add_argument("goal")
    p_goal.add_argument("--slug")
    p_goal.set_defaults(func=cmd_new_goal)

    p_list = sub.add_parser("list-projects")
    p_list.set_defaults(func=cmd_list_projects)

    p_approval = sub.add_parser("approval")
    approval_sub = p_approval.add_subparsers(dest="approval_command", required=True)
    p_create = approval_sub.add_parser("create")
    p_create.add_argument("action")
    p_create.add_argument("summary")
    p_create.add_argument("--risk", choices=["low", "medium", "high", "critical"], default="medium")
    p_create.set_defaults(func=cmd_approval_create)
    p_approve = approval_sub.add_parser("approve")
    p_approve.add_argument("id")
    p_approve.set_defaults(func=lambda args: update_approval(args, "approved"))
    p_deny = approval_sub.add_parser("deny")
    p_deny.add_argument("id")
    p_deny.set_defaults(func=lambda args: update_approval(args, "denied"))
    p_alist = approval_sub.add_parser("list")
    p_alist.add_argument("--status")
    p_alist.set_defaults(func=cmd_approval_list)

    p_report = sub.add_parser("report")
    p_report.set_defaults(func=cmd_report)

    p_risk = sub.add_parser("risk")
    risk_sub = p_risk.add_subparsers(dest="risk_command", required=True)
    p_risk_check = risk_sub.add_parser("check")
    p_risk_check.add_argument("action")
    p_risk_check.add_argument("summary")
    p_risk_check.set_defaults(func=cmd_risk_check)
    p_risk_request = risk_sub.add_parser("request")
    p_risk_request.add_argument("action")
    p_risk_request.add_argument("summary")
    p_risk_request.set_defaults(func=cmd_risk_request)

    p_demo = sub.add_parser("run-demo")
    p_demo.add_argument("demo", choices=["landing-page"])
    p_demo.set_defaults(func=cmd_run_demo)

    p_digest = sub.add_parser("digest")
    digest_sub = p_digest.add_subparsers(dest="digest_command", required=True)
    p_daily = digest_sub.add_parser("daily")
    p_daily.add_argument("--json-only", action="store_true")
    p_daily.set_defaults(func=cmd_digest_daily)

    p_cron = sub.add_parser("cron")
    cron_sub = p_cron.add_subparsers(dest="cron_command", required=True)
    p_template = cron_sub.add_parser("template")
    p_template.add_argument("template", choices=["daily-digest"])
    p_template.set_defaults(func=cmd_cron_template)

    p_release = sub.add_parser("release")
    release_sub = p_release.add_subparsers(dest="release_command", required=True)
    p_release_check = release_sub.add_parser("check")
    p_release_check.add_argument("--pretty", action="store_true")
    p_release_check.set_defaults(func=cmd_release_check)

    p_kanban = sub.add_parser("kanban")
    kanban_sub = p_kanban.add_subparsers(dest="kanban_command", required=True)
    p_export = kanban_sub.add_parser("export")
    p_export.add_argument("slug")
    p_export.set_defaults(func=cmd_kanban_export)

    p_voice = sub.add_parser("voice")
    voice_sub = p_voice.add_subparsers(dest="voice_command", required=True)
    p_voice_status = voice_sub.add_parser("status")
    p_voice_status.add_argument("--pretty", action="store_true")
    p_voice_status.set_defaults(func=cmd_voice_status)
    p_voice_test = voice_sub.add_parser("test")
    p_voice_test.add_argument("--provider", required=True)
    p_voice_test.add_argument("--text")
    p_voice_test.add_argument("--pretty", action="store_true")
    p_voice_test.set_defaults(func=cmd_voice_test)
    p_voice_session = voice_sub.add_parser("session")
    p_voice_session.add_argument("--provider", required=True)
    p_voice_session.add_argument("--text", required=True)
    p_voice_session.add_argument("--pretty", action="store_true")
    p_voice_session.set_defaults(func=cmd_voice_session)
    p_voice_sample = voice_sub.add_parser("sample")
    p_voice_sample.add_argument("--text", required=True)
    p_voice_sample.add_argument("--pretty", action="store_true")
    p_voice_sample.set_defaults(func=cmd_voice_sample)
    p_voice_loop = voice_sub.add_parser("loop")
    p_voice_loop.add_argument("--provider", required=True)
    p_voice_loop.add_argument("--once", action="store_true")
    p_voice_loop.add_argument("--cycles", type=int)
    p_voice_loop.add_argument("--interval", type=float, default=0.0)
    p_voice_loop.add_argument("--text")
    p_voice_loop.add_argument("--pretty", action="store_true")
    p_voice_loop.set_defaults(func=cmd_voice_loop)
    p_voice_transcripts = voice_sub.add_parser("transcripts")
    p_voice_transcripts.add_argument("--provider")
    p_voice_transcripts.add_argument("--status")
    p_voice_transcripts.add_argument("--query")
    p_voice_transcripts.add_argument("--limit", type=int, default=20)
    p_voice_transcripts.add_argument("--pretty", action="store_true")
    p_voice_transcripts.set_defaults(func=cmd_voice_transcripts)

    p_agent = sub.add_parser("agent")
    agent_sub = p_agent.add_subparsers(dest="agent_command", required=True)
    p_agent_queue = agent_sub.add_parser("queue")
    agent_queue_sub = p_agent_queue.add_subparsers(dest="agent_queue_command", required=True)
    p_agent_queue_sync = agent_queue_sub.add_parser("sync")
    p_agent_queue_sync.add_argument("--pretty", action="store_true")
    p_agent_queue_sync.set_defaults(func=cmd_agent_queue_sync)
    p_agent_queue_list = agent_queue_sub.add_parser("list")
    p_agent_queue_list.add_argument("--pretty", action="store_true")
    p_agent_queue_list.set_defaults(func=cmd_agent_queue_list)
    p_agent_queue_claim = agent_queue_sub.add_parser("claim")
    p_agent_queue_claim.add_argument("--queue-id", required=True)
    p_agent_queue_claim.add_argument("--worker", required=True)
    p_agent_queue_claim.add_argument("--pretty", action="store_true")
    p_agent_queue_claim.set_defaults(func=cmd_agent_queue_claim)
    p_agent_queue_start = agent_queue_sub.add_parser("start")
    p_agent_queue_start.add_argument("--queue-id", required=True)
    p_agent_queue_start.add_argument("--pretty", action="store_true")
    p_agent_queue_start.set_defaults(func=cmd_agent_queue_start)
    p_agent_queue_lease = agent_queue_sub.add_parser("lease")
    p_agent_queue_lease.add_argument("--queue-id", required=True)
    p_agent_queue_lease.add_argument("--worker", required=True)
    p_agent_queue_lease.add_argument("--ttl-seconds", type=int, default=300)
    p_agent_queue_lease.add_argument("--pretty", action="store_true")
    p_agent_queue_lease.set_defaults(func=cmd_agent_queue_lease)
    p_agent_queue_heartbeat = agent_queue_sub.add_parser("heartbeat")
    p_agent_queue_heartbeat.add_argument("--queue-id", required=True)
    p_agent_queue_heartbeat.add_argument("--worker", required=True)
    p_agent_queue_heartbeat.add_argument("--ttl-seconds", type=int, default=300)
    p_agent_queue_heartbeat.add_argument("--pretty", action="store_true")
    p_agent_queue_heartbeat.set_defaults(func=cmd_agent_queue_heartbeat)
    p_agent_queue_requeue_stale = agent_queue_sub.add_parser("requeue-stale")
    p_agent_queue_requeue_stale.add_argument("--pretty", action="store_true")
    p_agent_queue_requeue_stale.set_defaults(func=cmd_agent_queue_requeue_stale)
    p_agent_queue_fail = agent_queue_sub.add_parser("fail")
    p_agent_queue_fail.add_argument("--queue-id", required=True)
    p_agent_queue_fail.add_argument("--reason", required=True)
    p_agent_queue_fail.add_argument("--pretty", action="store_true")
    p_agent_queue_fail.set_defaults(func=cmd_agent_queue_fail)
    p_agent_queue_retry = agent_queue_sub.add_parser("retry")
    p_agent_queue_retry.add_argument("--queue-id", required=True)
    p_agent_queue_retry.add_argument("--pretty", action="store_true")
    p_agent_queue_retry.set_defaults(func=cmd_agent_queue_retry)
    p_agent_queue_cancel = agent_queue_sub.add_parser("cancel")
    p_agent_queue_cancel.add_argument("--queue-id", required=True)
    p_agent_queue_cancel.add_argument("--reason", required=True)
    p_agent_queue_cancel.add_argument("--pretty", action="store_true")
    p_agent_queue_cancel.set_defaults(func=cmd_agent_queue_cancel)
    p_agent_queue_complete = agent_queue_sub.add_parser("complete")
    p_agent_queue_complete.add_argument("--queue-id", required=True)
    p_agent_queue_complete.add_argument("--pretty", action="store_true")
    p_agent_queue_complete.set_defaults(func=cmd_agent_queue_complete)
    p_agent_queue_execute = agent_queue_sub.add_parser("execute")
    p_agent_queue_execute.add_argument("--queue-id", required=True)
    p_agent_queue_execute.add_argument("--worker", required=True)
    p_agent_queue_execute.add_argument("--pretty", action="store_true")
    p_agent_queue_execute.set_defaults(func=cmd_agent_queue_execute)
    p_agent_queue_run_next = agent_queue_sub.add_parser("run-next")
    p_agent_queue_run_next.add_argument("--worker", required=True)
    p_agent_queue_run_next.add_argument("--ttl-seconds", type=int, default=300)
    p_agent_queue_run_next.add_argument("--queue-id")
    p_agent_queue_run_next.add_argument("--project")
    p_agent_queue_run_next.add_argument("--owner")
    p_agent_queue_run_next.add_argument("--pretty", action="store_true")
    p_agent_queue_run_next.set_defaults(func=cmd_agent_queue_run_next)
    p_agent_queue_runs = agent_queue_sub.add_parser("runs")
    p_agent_queue_runs.add_argument("--limit", type=int, default=20)
    p_agent_queue_runs.add_argument("--pretty", action="store_true")
    p_agent_queue_runs.set_defaults(func=cmd_agent_queue_runs)
    p_agent_queue_run_batch = agent_queue_sub.add_parser("run-batch")
    p_agent_queue_run_batch.add_argument("--worker", required=True)
    p_agent_queue_run_batch.add_argument("--max-items", type=int, default=1)
    p_agent_queue_run_batch.add_argument("--ttl-seconds", type=int, default=300)
    p_agent_queue_run_batch.add_argument("--queue-id")
    p_agent_queue_run_batch.add_argument("--project")
    p_agent_queue_run_batch.add_argument("--owner")
    p_agent_queue_run_batch.add_argument("--dry-run", action="store_true")
    p_agent_queue_run_batch.add_argument("--pretty", action="store_true")
    p_agent_queue_run_batch.set_defaults(func=cmd_agent_queue_run_batch)

    p_agent_worker = agent_sub.add_parser("worker")
    agent_worker_sub = p_agent_worker.add_subparsers(dest="agent_worker_command", required=True)
    p_agent_worker_status = agent_worker_sub.add_parser("status")
    p_agent_worker_status.add_argument("--pretty", action="store_true")
    p_agent_worker_status.set_defaults(func=cmd_agent_worker_status)
    p_agent_worker_configure = agent_worker_sub.add_parser("configure")
    p_agent_worker_configure.add_argument("--worker")
    p_agent_worker_configure.add_argument("--max-items-per-tick", type=int)
    p_agent_worker_configure.add_argument("--ttl-seconds", type=int)
    p_agent_worker_configure.add_argument("--interval-seconds", type=int)
    p_agent_worker_configure.add_argument("--preview-ttl-seconds", type=int)
    p_agent_worker_configure.add_argument("--queue-id")
    p_agent_worker_configure.add_argument("--project")
    p_agent_worker_configure.add_argument("--owner")
    p_agent_worker_configure.add_argument("--dry-run", dest="dry_run", action="store_true", default=None)
    p_agent_worker_configure.add_argument("--no-dry-run", dest="dry_run", action="store_false")
    p_agent_worker_configure.add_argument("--runtime-mode", choices=["dry_run", "execute"])
    p_agent_worker_configure.add_argument("--pretty", action="store_true")
    p_agent_worker_configure.set_defaults(func=cmd_agent_worker_configure)
    p_agent_worker_tick = agent_worker_sub.add_parser("tick")
    p_agent_worker_tick.add_argument("--preview", action="store_true")
    p_agent_worker_tick.add_argument("--pretty", action="store_true")
    p_agent_worker_tick.set_defaults(func=cmd_agent_worker_tick)
    p_agent_worker_request_enable = agent_worker_sub.add_parser("request-enable")
    p_agent_worker_request_enable.add_argument("--summary")
    p_agent_worker_request_enable.add_argument("--pretty", action="store_true")
    p_agent_worker_request_enable.set_defaults(func=cmd_agent_worker_request_enable)
    p_agent_worker_enable = agent_worker_sub.add_parser("enable")
    p_agent_worker_enable.add_argument("--approval-id", required=True)
    p_agent_worker_enable.add_argument("--pretty", action="store_true")
    p_agent_worker_enable.set_defaults(func=cmd_agent_worker_enable)
    p_agent_worker_runtime_tick = agent_worker_sub.add_parser("runtime-tick")
    p_agent_worker_runtime_tick.add_argument("--confirm-execute", action="store_true")
    p_agent_worker_runtime_tick.add_argument("--confirmation-token")
    p_agent_worker_runtime_tick.add_argument("--pretty", action="store_true")
    p_agent_worker_runtime_tick.set_defaults(func=cmd_agent_worker_runtime_tick)
    p_agent_worker_runtime_preview = agent_worker_sub.add_parser("runtime-preview")
    p_agent_worker_runtime_preview.add_argument("--pretty", action="store_true")
    p_agent_worker_runtime_preview.set_defaults(func=cmd_agent_worker_runtime_preview)
    p_agent_worker_runtime_preview_revoke = agent_worker_sub.add_parser("runtime-preview-revoke")
    p_agent_worker_runtime_preview_revoke.add_argument("--preview-id")
    p_agent_worker_runtime_preview_revoke.add_argument("--confirmation-token")
    p_agent_worker_runtime_preview_revoke.add_argument("--reason")
    p_agent_worker_runtime_preview_revoke.add_argument("--pretty", action="store_true")
    p_agent_worker_runtime_preview_revoke.set_defaults(func=cmd_agent_worker_runtime_preview_revoke)
    p_agent_worker_runtime_preview_expire_stale = agent_worker_sub.add_parser("runtime-preview-expire-stale")
    p_agent_worker_runtime_preview_expire_stale.add_argument("--pretty", action="store_true")
    p_agent_worker_runtime_preview_expire_stale.set_defaults(func=cmd_agent_worker_runtime_preview_expire_stale)
    p_agent_worker_runtime_preview_detail = agent_worker_sub.add_parser("runtime-preview-detail")
    p_agent_worker_runtime_preview_detail.add_argument("--preview-id")
    p_agent_worker_runtime_preview_detail.add_argument("--confirmation-token")
    p_agent_worker_runtime_preview_detail.add_argument("--pretty", action="store_true")
    p_agent_worker_runtime_preview_detail.set_defaults(func=cmd_agent_worker_runtime_preview_detail)
    p_agent_worker_runtime_preview_validate_token = agent_worker_sub.add_parser("runtime-preview-validate-token")
    p_agent_worker_runtime_preview_validate_token.add_argument("--confirmation-token")
    p_agent_worker_runtime_preview_validate_token.add_argument("--preview-id")
    p_agent_worker_runtime_preview_validate_token.add_argument("--pretty", action="store_true")
    p_agent_worker_runtime_preview_validate_token.set_defaults(func=cmd_agent_worker_runtime_preview_validate_token)
    p_agent_worker_runtime_previews = agent_worker_sub.add_parser("runtime-previews")
    p_agent_worker_runtime_previews.add_argument("--limit", type=int, default=20)
    p_agent_worker_runtime_previews.add_argument("--status")
    p_agent_worker_runtime_previews.add_argument("--pretty", action="store_true")
    p_agent_worker_runtime_previews.set_defaults(func=cmd_agent_worker_runtime_previews)
    p_agent_worker_runtime_audits = agent_worker_sub.add_parser("runtime-audits")
    p_agent_worker_runtime_audits.add_argument("--limit", type=int, default=20)
    p_agent_worker_runtime_audits.add_argument("--pretty", action="store_true")
    p_agent_worker_runtime_audits.set_defaults(func=cmd_agent_worker_runtime_audits)

    p_command = sub.add_parser("command")
    p_command.add_argument("text")
    p_command.set_defaults(func=cmd_command)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
