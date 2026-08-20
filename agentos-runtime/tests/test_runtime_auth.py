"""The runtime used to answer every caller that could reach port 8765.

Some of its routes approve queued actions and shell out to the Hermes CLI, so
"it is only on the private Docker network" was the whole of its access control.
These tests pin the shared-secret gate and the removal of the shell from the
Kanban execution path.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "dashboard" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import app  # noqa: E402


def headers(mapping):
    """The stdlib handler exposes headers as a case-insensitive mapping."""
    lowered = {key.lower(): value for key, value in mapping.items()}
    return type("Headers", (), {"get": lambda self, key, default=None: lowered.get(key.lower(), default)})()


def test_a_configured_token_is_required(monkeypatch):
    monkeypatch.setenv(app.RUNTIME_TOKEN_ENV, "s3cret")

    assert app.request_is_authorised(headers({"Authorization": "Bearer s3cret"})) is True
    assert app.request_is_authorised(headers({"X-Internal-Secret": "s3cret"})) is True

    assert app.request_is_authorised(headers({})) is False
    assert app.request_is_authorised(headers({"Authorization": "Bearer wrong"})) is False
    assert app.request_is_authorised(headers({"Authorization": "s3cret"})) is False
    assert app.request_is_authorised(headers({"Authorization": "Bearer "})) is False


def test_an_unconfigured_runtime_stays_open_rather_than_breaking_itself(monkeypatch):
    # An install that has not been redeployed yet would otherwise lose its
    # orchestrator outright. The state is reported, not hidden.
    monkeypatch.delenv(app.RUNTIME_TOKEN_ENV, raising=False)
    assert app.request_is_authorised(headers({})) is True

    monkeypatch.setenv(app.RUNTIME_TOKEN_ENV, "   ")
    assert app.runtime_token() == ""
    assert app.request_is_authorised(headers({})) is True


def test_both_verbs_refuse_an_unauthorised_caller():
    source = (BACKEND / "app.py").read_text(encoding="utf-8")
    # A gate on do_GET alone would leave every mutating route wide open.
    assert source.count("if not request_is_authorised(self.headers):") == 2


@pytest.mark.parametrize("objective", [
    "Ship $(touch /tmp/pwned) the collection",
    "Ship `id` the collection",
    "Ship; rm -rf / #the collection",
    'Ship "quoted" and \'mixed\' text',
])
def test_task_text_cannot_become_a_shell_command(tmp_path, monkeypatch, objective):
    monkeypatch.setattr(app, "project_tasks", lambda workspace, slug: [{
        "id": "T001",
        "objective": objective,
        "owner": "coding-agent",
        "depends_on": [],
        "acceptance_criteria": ["done"],
    }])

    argv = app.kanban_argv_for_project(tmp_path, "demo", {"coding-agent": "default"})[0]

    # The objective arrives as one argument. Nothing splits it, so there is no
    # shell to interpret the metacharacters it contains.
    assert argv[:3] == ["hermes", "kanban", "create"]
    assert argv[argv.index("--title") + 1] == f"T001: {objective}"
    assert argv[argv.index("--assignee") + 1] == "default"


def test_the_shell_is_gone_from_the_execution_path():
    source = (BACKEND / "app.py").read_text(encoding="utf-8")
    assert "shell=True" not in source
    # The dry run still shows an operator a copy-pasteable command.
    assert "shlex.join(argv)" in source
