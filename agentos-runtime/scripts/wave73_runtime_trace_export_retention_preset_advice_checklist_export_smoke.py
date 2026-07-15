import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import request

ROOT = Path('C:/Users/User/AgentOS')
CLI = ROOT / 'agentosctl.py'
BASE = 'http://127.0.0.1:8765'
EXPORT_DIR = ROOT / 'artifacts' / 'agent-worker' / 'runtime-traces'
ARCHIVE_DIR = EXPORT_DIR / 'archive'
CHECKLIST_EXPORT_DIR = ROOT / 'artifacts' / 'agent-worker' / 'runtime-trace-retention'
HISTORY = ROOT / 'logs' / 'agent-worker' / 'retention-preset-advice-history.json'
LEDGERS = [
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
    HISTORY,
]
MARKERS = [
    'Export checklist evidence dossier',
    'exportAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklist',
    '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export',
    'confirm_export',
    'runtime_trace_export_retention_preset_advice_checklist_export',
    'artifact_relpath',
    'artifact_write_enabled',
]


def run_cli(*args):
    proc = subprocess.run([sys.executable, str(CLI), '--workspace', str(ROOT), *args], text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"CLI failed {' '.join(args)}\nSTDOUT={proc.stdout}\nSTDERR={proc.stderr}")
    return json.loads(proc.stdout)


def api(path):
    with request.urlopen(BASE + path, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))


def post(path, payload):
    data = json.dumps(payload).encode('utf-8')
    req = request.Request(BASE + path, data=data, method='POST', headers={'Content-Type': 'application/json'})
    with request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))


def text(path):
    with request.urlopen(BASE + path, timeout=15) as resp:
        return resp.read().decode('utf-8')


def file_snapshot(paths):
    return {str(path): path.read_text(encoding='utf-8') if path.exists() else None for path in paths}


def write_artifact(path, size, mtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('x' * size, encoding='utf-8')
    os.utime(path, (mtime, mtime))


def wait_ready():
    last = None
    for _ in range(30):
        try:
            status = api('/api/status')
            if status.get('workspace'):
                return status
        except Exception as exc:
            last = exc
            time.sleep(0.5)
    raise RuntimeError(f'dashboard not ready: {last}')


def main():
    status = wait_ready()
    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    for idx in range(30):
        temp_paths.append(EXPORT_DIR / f'wave73_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(110):
        temp_paths.append(ARCHIVE_DIR / f'wave73_archive_{stamp}_{idx:03d}_trace_202606171010{idx:03d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)
    exported_artifact = None

    try:
        future_base = int(time.time()) + 3600
        for idx in range(30):
            write_artifact(EXPORT_DIR / f'wave73_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(110):
            write_artifact(ARCHIVE_DIR / f'wave73_archive_{stamp}_{idx:03d}_trace_202606171010{idx:03d}.md', 20 + idx, future_base + 100 + idx)

        blocked = post('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export', {'confirm_export': False, 'reason': 'wave73_blocked_smoke'})
        assert blocked['status'] == 'runtime_trace_export_retention_preset_advice_checklist_export_confirmation_required', blocked
        assert blocked['will_export'] is False and blocked['artifact_write_enabled'] is False, blocked

        preview = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview?max_chars=900')
        assert preview['status'] == 'ok', preview
        assert preview['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_export_preview', preview
        assert preview['evidence_summary']['recommended_preset'] == 'conservative', preview

        exported = post('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export', {'confirm_export': True, 'reason': 'wave73_confirmed_smoke'})
        assert exported['status'] == 'runtime_trace_export_retention_preset_advice_checklist_exported', exported
        assert exported['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_export', exported
        assert exported['dry_run'] is False and exported['will_export'] is True, exported
        assert exported['writes_enabled'] is True and exported['artifact_write_enabled'] is True, exported
        assert exported['artifact_only_mutation'] is True, exported
        assert exported['operational_ledgers_mutated'] is False, exported
        assert exported['history_writes_enabled'] is False, exported
        assert exported['retention_apply_called'] is False, exported
        assert exported['evidence_summary']['recommended_preset'] == 'conservative', exported
        assert exported['evidence_summary']['recommended_action'] == 'review_retention_preview', exported
        assert exported['evidence_summary']['severity'] == 'action_recommended', exported
        assert exported['evidence_summary']['operator_state'] == 'pending_operator_review', exported
        assert exported['evidence_summary']['archive_candidate_count'] >= 5, exported
        assert exported['evidence_summary']['prune_candidate_count'] >= 10, exported
        assert exported['evidence_summary']['total_candidate_count'] >= 15, exported
        exported_artifact = Path(exported['artifact_path'])
        assert exported_artifact.exists(), exported
        assert exported_artifact.parent == CHECKLIST_EXPORT_DIR, exported
        assert exported['artifact_relpath'].startswith('artifacts/agent-worker/runtime-trace-retention/'), exported
        content = exported_artifact.read_text(encoding='utf-8')
        assert content.startswith('# Retention Preset Advice Checklist Evidence'), content[:200]
        assert 'Decision: runtime_trace_export_retention_preset_advice_checklist_export' in content
        assert 'Recommended preset: conservative' in content
        assert 'Recommended action: review_retention_preview' in content
        assert '## Safety Gates' in content
        assert 'dry_run_only' in content
        assert '## Linked Endpoints' in content
        assert '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence' in content
        assert 'wave73_confirmed_smoke' in content
        assert 'confirmation_token' not in content.lower()
        assert exported['export_preview']['content_length'] == exported['artifact_size_bytes'], exported
        assert exported['export_preview']['redactions'] == ['confirmation_token', 'confirmation.token', 'execution_context.confirmation_token'], exported

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'confirmed checklist export must not mutate operational/history ledgers'
        assert all(path.exists() for path in temp_paths), 'confirmed checklist export must not move/delete runtime trace artifacts'

        html = text('/')
        assert all(marker in html for marker in MARKERS), MARKERS

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('blocked-export', blocked['status'], blocked['will_export'], blocked['artifact_write_enabled'])
        print('preview-match', preview['evidence_summary']['recommended_preset'] == exported['evidence_summary']['recommended_preset'])
        print('confirmed-export', exported['status'], exported['decision'], exported['dry_run'], exported['will_export'], exported['artifact_write_enabled'])
        print('artifact', exported['artifact_relpath'], exported['artifact_size_bytes'], exported_artifact.exists())
        print('summary', exported['evidence_summary'])
        print('markdown-markers', '# Retention Preset Advice Checklist Evidence' in content, '## Safety Gates' in content, '## Linked Endpoints' in content)
        print('redactions', exported['export_preview']['redactions'])
        print('read-only-ledgers', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('artifacts-preserved', all(path.exists() for path in temp_paths))
        print('frontend-markers', True, ','.join(MARKERS))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if exported_artifact and exported_artifact.exists():
            exported_artifact.unlink()
        for item_path, original in originals.items():
            item_path = Path(item_path)
            if original is None:
                if item_path.exists():
                    item_path.unlink()
            else:
                item_path.parent.mkdir(parents=True, exist_ok=True)
                item_path.write_text(original, encoding='utf-8')


if __name__ == '__main__':
    main()
