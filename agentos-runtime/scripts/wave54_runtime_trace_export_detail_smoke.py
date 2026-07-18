import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import request

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'agentosctl.py'
BASE = 'http://127.0.0.1:8765'
EXPORT_DIR = ROOT / 'artifacts' / 'agent-worker' / 'runtime-traces'
LEDGERS = [
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
]


def run_cli(*args):
    proc = subprocess.run([sys.executable, str(CLI), '--workspace', str(ROOT), *args], text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"CLI failed {' '.join(args)}\nSTDOUT={proc.stdout}\nSTDERR={proc.stderr}")
    return json.loads(proc.stdout)


def api(path):
    with request.urlopen(BASE + path, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def text(path):
    with request.urlopen(BASE + path, timeout=10) as resp:
        return resp.read().decode('utf-8')


def file_snapshot(paths):
    return {str(path): path.read_text(encoding='utf-8') if path.exists() else None for path in paths}


def write_export(one_shot_run_id):
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = EXPORT_DIR / f'{one_shot_run_id}_trace.md'
    content = '\n'.join([
        f'# Runtime Trace Export — {one_shot_run_id}',
        '',
        '## Summary',
        '- Preview ID: preview_wave54_smoke',
        f'- confirmation_token: token_{one_shot_run_id}_secret',
        '',
        '## Safety Metadata',
        '- Operational ledgers mutated: false',
        '- Artifact only write: true',
        '',
        '## Body',
        '0123456789' * 80,
    ])
    path.write_text(content, encoding='utf-8')
    os.utime(path, (int(time.time()) + 100, int(time.time()) + 100))
    return path, content


def main():
    last = None
    for _ in range(30):
        try:
            status = api('/api/status')
            if status.get('workspace'):
                break
        except Exception as exc:
            last = exc
            time.sleep(0.5)
    else:
        raise RuntimeError(f'dashboard not ready: {last}')

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    one_shot_run_id = f'wave54_smoke_{stamp}_trace'
    path = EXPORT_DIR / f'{one_shot_run_id}_trace.md'
    original = path.read_text(encoding='utf-8') if path.exists() else None
    ledger_before = file_snapshot(LEDGERS)
    try:
        path, raw_content = write_export(one_shot_run_id)
        export_before = path.read_text(encoding='utf-8')

        detail = api(f'/api/agent-worker/runtime-trace-exports/{one_shot_run_id}?max_chars=220')
        assert detail['status'] == 'runtime_trace_export_found', detail
        assert detail['decision'] == 'runtime_trace_export_detail', detail
        assert detail['one_shot_run_id'] == one_shot_run_id, detail
        assert detail['filename'] == f'{one_shot_run_id}_trace.md', detail
        assert detail['artifact_relpath'] == f'artifacts/agent-worker/runtime-traces/{one_shot_run_id}_trace.md', detail
        assert detail['max_chars'] == 220, detail
        assert len(detail['content_preview']) == 220, detail
        assert detail['truncated'] is True, detail
        assert f'token_{one_shot_run_id}_secret' not in detail['content_preview'], detail
        assert '[REDACTED]' in detail['content_preview'], detail
        assert detail['links']['trace_graph'] == f'/api/agent-worker/runtime-traces/{one_shot_run_id}', detail
        assert detail['links']['regenerate_export'] == f'/api/agent-worker/runtime-traces/{one_shot_run_id}/export', detail

        full = api(f'/api/agent-worker/runtime-trace-exports/{one_shot_run_id}?max_chars=0')
        assert full['status'] == 'runtime_trace_export_found', full
        assert full['truncated'] is False, full
        assert '## Body' in full['content_preview'], full
        assert f'token_{one_shot_run_id}_secret' not in full['content_preview'], full

        missing = api('/api/agent-worker/runtime-trace-exports/wave54_missing_export?max_chars=100')
        assert missing['status'] == 'runtime_trace_export_not_found', missing
        assert missing['content_preview'] == '', missing
        assert missing['links'] == {'export_index': '/api/agent-worker/runtime-trace-exports?limit=20'}, missing

        index = api('/api/agent-worker/runtime-trace-exports?limit=5')
        assert one_shot_run_id in [item['one_shot_run_id'] for item in index['exports']], index

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'export detail must not mutate operational ledgers'
        assert path.read_text(encoding='utf-8') == export_before, 'export detail must not mutate artifact content'

        html = text('/')
        markers = [
            'showAgentWorkerRuntimeTraceExportDetail',
            '/api/agent-worker/runtime-trace-exports/${encodeURIComponent(oneShotRunId)}?max_chars=4000',
            'Runtime trace export detail',
            'View export',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('trace-export-detail', detail['status'], detail['one_shot_run_id'], detail['max_chars'], detail['truncated'])
        print('trace-export-detail-redacted', '[REDACTED]' in detail['content_preview'], f'token_{one_shot_run_id}_secret' not in full['content_preview'])
        print('trace-export-detail-full', full['status'], full['truncated'], len(full['content_preview']))
        print('not-found-detail', missing['status'], missing['artifact_path'], missing['artifact_relpath'])
        print('index-has-export', True)
        print('read-only', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before}, 'artifact_unchanged', path.read_text(encoding='utf-8') == export_before)
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if original is None:
            if path.exists():
                path.unlink()
        else:
            path.write_text(original, encoding='utf-8')


if __name__ == '__main__':
    main()
