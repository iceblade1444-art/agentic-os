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
ARCHIVE_DIR = EXPORT_DIR / 'archive'
PRUNED_DIR = EXPORT_DIR / 'pruned'
LEDGERS = [
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
]
OLD_EPOCH = 946684800


def run_cli(*args):
    proc = subprocess.run([sys.executable, str(CLI), '--workspace', str(ROOT), *args], text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"CLI failed {' '.join(args)}\nSTDOUT={proc.stdout}\nSTDERR={proc.stderr}")
    return json.loads(proc.stdout)


def api(path, method='GET', payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = request.Request(BASE + path, data=data, headers=headers, method=method)
    with request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def text(path):
    with request.urlopen(BASE + path, timeout=10) as resp:
        return resp.read().decode('utf-8')


def file_snapshot(paths):
    return {str(path): path.read_text(encoding='utf-8') if path.exists() else None for path in paths}


def write_file(path, content, mtime=OLD_EPOCH):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    os.utime(path, (mtime, mtime))


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
    pruned_id = f'wave59_detail_{stamp}_trace_20260617010101_pruned_{stamp}'
    missing_id = f'wave59_missing_{stamp}_trace_20260617010101_pruned_{stamp}'
    path = PRUNED_DIR / f'{pruned_id}.md'
    originals = file_snapshot([path])
    ledger_before = file_snapshot(LEDGERS)
    try:
        content = '\n'.join([
            f'# Runtime Trace Export — wave59 detail {stamp}',
            'confirmation_token: SECRET_TOKEN_SHOULD_NOT_LEAK',
            'confirmation_token=ANOTHER_SECRET_SHOULD_NOT_LEAK',
            'body=' + ('x' * 200),
        ])
        write_file(path, content)

        detail = api(f'/api/agent-worker/runtime-trace-export-pruned/{pruned_id}?max_chars=140')
        assert detail['status'] == 'runtime_trace_export_pruned_found', detail
        assert detail['decision'] == 'runtime_trace_export_pruned_detail', detail
        assert detail['pruned_id'] == pruned_id, detail
        assert detail['max_chars'] == 140, detail
        assert detail['truncated'] is True, detail
        assert len(detail['content_preview']) <= 140, detail
        assert 'SECRET_TOKEN_SHOULD_NOT_LEAK' not in detail['content_preview'], detail
        assert 'ANOTHER_SECRET_SHOULD_NOT_LEAK' not in detail['content_preview'], detail
        assert 'confirmation_token: [REDACTED]' in detail['content_preview'], detail
        assert 'confirmation_token=[REDACTED]' in detail['content_preview'], detail
        assert detail['links']['restore'].endswith(f'/{pruned_id}/restore'), detail
        assert detail['links']['delete'].endswith(f'/{pruned_id}/delete'), detail
        assert path.read_text(encoding='utf-8') == content, detail

        full = api(f'/api/agent-worker/runtime-trace-export-pruned/{pruned_id}?max_chars=0')
        assert full['status'] == 'runtime_trace_export_pruned_found', full
        assert full['truncated'] is False, full
        assert 'SECRET_TOKEN_SHOULD_NOT_LEAK' not in full['content_preview'], full
        assert 'ANOTHER_SECRET_SHOULD_NOT_LEAK' not in full['content_preview'], full
        assert 'body=' in full['content_preview'], full

        missing = api(f'/api/agent-worker/runtime-trace-export-pruned/{missing_id}?max_chars=4000')
        assert missing['status'] == 'runtime_trace_export_pruned_not_found', missing
        assert missing['decision'] == 'runtime_trace_export_pruned_detail', missing
        assert missing['content_preview'] == '', missing
        assert missing['truncated'] is False, missing

        index = api('/api/agent-worker/runtime-trace-export-pruned?limit=0')
        assert pruned_id in [item['pruned_id'] for item in index['pruned']], index
        restore_gate = api(f'/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/restore', method='POST', payload={})
        delete_gate = api(f'/api/agent-worker/runtime-trace-export-pruned/{pruned_id}/delete', method='POST', payload={})
        assert restore_gate['status'] == 'runtime_trace_export_pruned_restore_confirmation_required', restore_gate
        assert delete_gate['status'] == 'runtime_trace_export_pruned_delete_confirmation_required', delete_gate
        assert path.exists() and path.read_text(encoding='utf-8') == content

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'pruned detail must not mutate operational ledgers'

        html = text('/')
        markers = [
            'showAgentWorkerRuntimeTraceExportPrunedDetail',
            '/api/agent-worker/runtime-trace-export-pruned/${encodeURIComponent(prunedId)}?max_chars=4000',
            'View pruned export',
            'Runtime trace pruned export detail',
            'restoreAgentWorkerRuntimeTraceExportPruned',
            'deleteAgentWorkerRuntimeTraceExportPruned',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('pruned-detail', detail['status'], detail['decision'], detail['truncated'], len(detail['content_preview']))
        print('pruned-detail-redacted', 'SECRET_TOKEN_SHOULD_NOT_LEAK' not in detail['content_preview'], 'ANOTHER_SECRET_SHOULD_NOT_LEAK' not in detail['content_preview'])
        print('pruned-detail-full', full['status'], full['truncated'], 'body=' in full['content_preview'])
        print('pruned-detail-missing', missing['status'], missing['decision'])
        print('pruned-index-still-lists', pruned_id in [item['pruned_id'] for item in index['pruned']])
        print('restore-delete-gates-still-work', restore_gate['status'], delete_gate['status'])
        print('read-only', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
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
