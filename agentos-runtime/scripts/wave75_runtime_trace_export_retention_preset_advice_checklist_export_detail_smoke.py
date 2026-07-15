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
    'showAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExportDetail',
    'View checklist export',
    '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/${encodeURIComponent(exportId)}?max_chars=1600',
    'runtime_trace_export_retention_preset_advice_checklist_export_detail',
    'content_preview',
    'truncated',
]


def run_cli(*args):
    proc = subprocess.run([sys.executable, str(CLI), '--workspace', str(ROOT), *args], text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"CLI failed {' '.join(args)}\nSTDOUT={proc.stdout}\nSTDERR={proc.stderr}")
    return json.loads(proc.stdout)


def api(path):
    with request.urlopen(BASE + path, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))


def text(path):
    with request.urlopen(BASE + path, timeout=15) as resp:
        return resp.read().decode('utf-8')


def file_snapshot(paths):
    return {str(path): path.read_text(encoding='utf-8') if path.exists() else None for path in paths}


def write_export(path, body, mtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding='utf-8')
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
    export_id = f'retention_preset_advice_checklist_evidence_{stamp}_detail75'
    artifact = CHECKLIST_EXPORT_DIR / f'{export_id}.md'
    originals = file_snapshot([artifact])
    ledger_before = file_snapshot(LEDGERS)

    body = (
        '# Retention Preset Advice Checklist Evidence\n\n'
        '- confirmation_token: LIVE_SECRET_SHOULD_NOT_LEAK\n'
        '- confirmation.token=LIVE_SECRET_TWO_SHOULD_NOT_LEAK\n'
        '- execution_context.confirmation_token: LIVE_SECRET_THREE_SHOULD_NOT_LEAK\n'
        '- Decision: runtime_trace_export_retention_preset_advice_checklist_export\n\n'
        '## Body\n\n'
        'live detail smoke content marker for wave 75.\n'
    )

    try:
        write_export(artifact, body, int(time.time()) + 7200)
        detail = api(f'/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/{export_id}?max_chars=140')
        assert detail['status'] == 'runtime_trace_export_retention_preset_advice_checklist_export_found', detail
        assert detail['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_export_detail', detail
        assert detail['dry_run'] is True and detail['will_apply'] is False, detail
        assert detail['writes_enabled'] is False and detail['artifact_write_enabled'] is False, detail
        assert detail['export_id'] == export_id, detail
        assert detail['artifact_relpath'] == f'artifacts/agent-worker/runtime-trace-retention/{export_id}.md', detail
        assert detail['truncated'] is True, detail
        assert len(detail['content_preview']) == 140, detail
        assert 'LIVE_SECRET' not in detail['content_preview'], detail['content_preview']
        assert '[REDACTED]' in detail['content_preview'], detail['content_preview']
        assert detail['safety']['read_only'] is True and detail['safety']['retention_apply_called'] is False, detail

        full = api(f'/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/{export_id}?max_chars=0')
        assert full['status'] == 'runtime_trace_export_retention_preset_advice_checklist_export_found', full
        assert full['truncated'] is False, full
        assert 'live detail smoke content marker for wave 75' in full['content_preview'], full
        assert 'LIVE_SECRET' not in full['content_preview'], full['content_preview']

        missing = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports/missing_wave75_export?max_chars=1600')
        assert missing['status'] == 'runtime_trace_export_retention_preset_advice_checklist_export_not_found', missing
        assert missing['content_preview'] == '', missing
        assert missing['truncated'] is False, missing

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'detail endpoint must not mutate operational/history ledgers'
        assert artifact.read_text(encoding='utf-8') == body, 'detail endpoint must not mutate artifact content'

        html = text('/')
        assert all(marker in html for marker in MARKERS), MARKERS

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('detail', detail['status'], detail['decision'], detail['dry_run'], detail['will_apply'], detail['writes_enabled'], detail['artifact_write_enabled'])
        print('detail-preview', detail['max_chars'], detail['content_length'], len(detail['content_preview']), detail['truncated'], '[REDACTED]' in detail['content_preview'])
        print('full-preview', full['max_chars'], full['truncated'], 'live detail smoke content marker for wave 75' in full['content_preview'])
        print('missing', missing['status'], missing['artifact_path'], missing['artifact_relpath'], missing['content_preview'] == '')
        print('redactions', detail['redactions'])
        print('links', detail['links'])
        print('read-only-ledgers', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('artifact-preserved', artifact.exists(), artifact.read_text(encoding='utf-8') == body)
        print('frontend-markers', True, ','.join(MARKERS))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        original = originals[str(artifact)]
        if original is None:
            if artifact.exists():
                artifact.unlink()
        else:
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_text(original, encoding='utf-8')


if __name__ == '__main__':
    main()
