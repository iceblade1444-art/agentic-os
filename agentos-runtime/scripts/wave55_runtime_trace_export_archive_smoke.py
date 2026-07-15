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


def write_export(one_shot_run_id):
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = EXPORT_DIR / f'{one_shot_run_id}_trace.md'
    content = (
        f'# Runtime Trace Export — {one_shot_run_id}\n\n'
        '## Summary\n- Preview ID: preview_wave55_smoke\n\n'
        '## Safety Metadata\n- Operational ledgers mutated: false\n- Artifact only write: true\n'
    )
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
    one_shot_run_id = f'wave55_smoke_{stamp}_trace'
    source = EXPORT_DIR / f'{one_shot_run_id}_trace.md'
    original = source.read_text(encoding='utf-8') if source.exists() else None
    ledger_before = file_snapshot(LEDGERS)
    archive_path = None
    try:
        source, content = write_export(one_shot_run_id)
        source_before = source.read_text(encoding='utf-8')

        no_confirm = api(
            f'/api/agent-worker/runtime-trace-exports/{one_shot_run_id}/archive',
            method='POST',
            payload={'reason': 'smoke_without_confirm'},
        )
        assert no_confirm['status'] == 'runtime_trace_export_archive_confirmation_required', no_confirm
        assert no_confirm['will_archive'] is False, no_confirm
        assert source.exists(), no_confirm
        assert source.read_text(encoding='utf-8') == source_before, no_confirm
        assert not (EXPORT_DIR / 'archive').exists() or not any((EXPORT_DIR / 'archive').glob(f'{one_shot_run_id}_trace_*.md')), no_confirm

        archived = api(
            f'/api/agent-worker/runtime-trace-exports/{one_shot_run_id}/archive',
            method='POST',
            payload={'confirm_archive': True, 'reason': 'wave55_smoke'},
        )
        assert archived['status'] == 'runtime_trace_export_archived', archived
        assert archived['decision'] == 'runtime_trace_export_archive', archived
        assert archived['artifact_only_mutation'] is True, archived
        assert archived['operational_ledgers_mutated'] is False, archived
        assert archived['archive_relpath'].startswith(f'artifacts/agent-worker/runtime-traces/archive/{one_shot_run_id}_trace_'), archived
        archive_path = Path(archived['archive_path'])
        assert archive_path.exists(), archived
        assert archive_path.read_text(encoding='utf-8') == source_before, archived
        assert not source.exists(), archived

        detail_after = api(f'/api/agent-worker/runtime-trace-exports/{one_shot_run_id}')
        assert detail_after['status'] == 'runtime_trace_export_not_found', detail_after
        index_after = api('/api/agent-worker/runtime-trace-exports?limit=0')
        assert one_shot_run_id not in [item['one_shot_run_id'] for item in index_after['exports']], index_after
        missing = api('/api/agent-worker/runtime-trace-exports/wave55_missing_archive/archive', method='POST', payload={'confirm_archive': True})
        assert missing['status'] == 'runtime_trace_export_archive_not_found', missing

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'archive must not mutate operational ledgers'

        html = text('/')
        markers = [
            'archiveAgentWorkerRuntimeTraceExport',
            '/api/agent-worker/runtime-trace-exports/${encodeURIComponent(oneShotRunId)}/archive',
            'confirm(`Archive runtime trace export',
            'confirm_archive: true',
            'Archive export',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('archive-confirmation-required', no_confirm['status'], no_confirm['will_archive'])
        print('archive-success', archived['status'], archived['one_shot_run_id'], archived['archive_relpath'])
        print('archive-content-preserved', archive_path.read_text(encoding='utf-8') == source_before)
        print('active-export-gone', detail_after['status'], one_shot_run_id not in [item['one_shot_run_id'] for item in index_after['exports']])
        print('missing-archive', missing['status'])
        print('read-only', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if archive_path and archive_path.exists():
            archive_path.unlink()
        if original is None:
            if source.exists():
                source.unlink()
        else:
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(original, encoding='utf-8')


if __name__ == '__main__':
    main()
