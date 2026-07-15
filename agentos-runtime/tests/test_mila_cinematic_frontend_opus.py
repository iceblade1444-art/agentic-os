from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "dashboard" / "frontend" / "index.html"


def test_frontend_has_cinematic_agentic_os_shell_markers():
    text = INDEX.read_text(encoding="utf-8")
    required = [
        "opusAgenticShell",
        "opus-command-center",
        "opus-left-rail",
        "opus-hero-stage",
        "opus-orbital-system",
        "opus-memory-constellation",
        "opus-agent-dock",
        "opus-command-bar",
        "opus-status-ticker",
        "toggleTechnicalPanels",
        "syncOpusShellMetrics",
        "Agentic OS // Mila",
    ]
    for marker in required:
        assert marker in text


def test_frontend_prioritizes_cinematic_shell_over_plain_dashboard_sprawl():
    text = INDEX.read_text(encoding="utf-8")
    assert text.find("id=\"opusAgenticShell\"") < text.find("aria-label=\"System Status\"")
    assert "legacy-panels-collapsed" in text
    assert "Show technical panels" in text
    assert "data-opus-metric=\"projects\"" in text
    assert "data-opus-metric=\"approvals\"" in text
    assert "data-opus-agent=\"orchestrator\"" in text
    assert "data-opus-agent=\"qa\"" in text


def test_frontend_has_high_fidelity_motion_and_depth_tokens():
    text = INDEX.read_text(encoding="utf-8")
    required_css = [
        "--opus-bg",
        "--opus-cyan",
        "--opus-violet",
        "backdrop-filter",
        "mix-blend-mode",
        "@keyframes opusOrbit",
        "@keyframes opusScan",
        "@keyframes opusBreath",
        "prefers-reduced-motion",
    ]
    for marker in required_css:
        assert marker in text
