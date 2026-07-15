import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "agentosctl.py"


def run_cli(tmp_path, *args):
    return subprocess.run([sys.executable, str(CLI), "--workspace", str(tmp_path), *args], text=True, capture_output=True)


def test_run_demo_creates_verified_landing_page(tmp_path):
    result = run_cli(tmp_path, "run-demo", "landing-page")

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "pass"
    project_dir = tmp_path / "projects" / "ai-seo-landing-page-demo"
    assert (project_dir / "index.html").exists()
    assert (project_dir / "qa-report.md").exists()
    html = (project_dir / "index.html").read_text(encoding="utf-8")
    assert "AI SEO systems" in html
    assert "Book a free SEO systems audit" in html


def test_run_demo_preserves_existing_project_created_at(tmp_path):
    result = run_cli(tmp_path, "run-demo", "landing-page")
    assert result.returncode == 0, result.stderr

    project_json = tmp_path / "projects" / "ai-seo-landing-page-demo" / "project.json"
    first_metadata = json.loads(project_json.read_text(encoding="utf-8"))

    second = run_cli(tmp_path, "run-demo", "landing-page")
    assert second.returncode == 0, second.stderr
    second_metadata = json.loads(project_json.read_text(encoding="utf-8"))

    assert second_metadata["created_at"] == first_metadata["created_at"]
    assert second_metadata["status"] == "demo_created"
