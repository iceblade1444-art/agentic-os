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
    return {path.name: path.read_text(encoding='utf-8') if path.exists() else None for path in paths}


def write_export(one_shot_run_id, modified_epoch):
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = EXPORT_DIR / f'{one_shot_run_id}_trace.md'
    path.write_text(
        f'# Runtime Trace Export — {one_shot_run_id}\n\n'
        '## Summary\n- Trace status: runtime_trace_found\n\n'
        '## Safety Metadata\n- Operational ledgers mutated: false\n- Artifact only write: true\n',
        encoding='utf-8',
    )
    os.utime(path, (modified_epoch, modified_epoch))
    return path


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

    ledger_before = file_snapshot(LEDGERS)
    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    ids = [
        f'wave53_smoke_{stamp}_old',
        f'wave53_smoke_{stamp}_middle',
        f'wave53_smoke_{stamp}_newest',
    ]
    now_epoch = int(time.time())
    paths = []
    originals = {}
    try:
        for offset, one_shot_run_id in enumerate(ids):
            path = EXPORT_DIR / f'{one_shot_run_id}_trace.md'
            originals[path] = path.read_text(encoding='utf-8') if path.exists() else None
            paths.append(write_export(one_shot_run_id, now_epoch + 100 + offset))

        limited = api('/api/agent-worker/runtime-trace-exports?limit=2')
        assert limited['status'] == 'ok', limited
        assert limited['decision'] == 'runtime_trace_export_index', limited
        assert limited['count'] == 2, limited
        assert limited['total'] >= 3, limited
        listed_ids = [item['one_shot_run_id'] for item in limited['exports'][:2]]
        assert listed_ids == [ids[2], ids[1]], limited
        assert limited['exports'][0]['artifact_relpath'] == f'artifacts/agent-worker/runtime-traces/{ids[2]}_trace.md', limited
        assert limited['exports'][0]['title'] == f'Runtime Trace Export — {ids[2]}', limited
        assert limited['exports'][0]['size_bytes'] > 0, limited
        assert limited['links']['exports_dir'] == 'artifacts/agent-worker/runtime-traces', limited

        all_exports = api('/api/agent-worker/runtime-trace-exports?limit=0')
        all_ids = [item['one_shot_run_id'] for item in all_exports['exports']]
        assert all(one_shot_run_id in all_ids for one_shot_run_id in ids), all_exports

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'export index must not mutate operational ledgers'

        html = text('/')
        markers = [
            'Runtime Trace Exports',
            'agentWorkerRuntimeTraceExports',
            'loadAgentWorkerRuntimeTraceExports',
            '/api/agent-worker/runtime-trace-exports?limit=10',
            'runtime_trace_export_index',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('trace-export-index', limited['status'], limited['decision'], limited['count'], limited['total'])
        print('trace-export-index-order', listed_ids)
        print('trace-export-index-all-has-smoke', all(one_shot_run_id in all_ids for one_shot_run_id in ids))
        print('read-only', {path.name: ledger_after[path.name] == ledger_before[path.name] for path in LEDGERS})
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        for path in paths:
            original = originals.get(path)
            if original is None:
                if path.exists():
                    path.unlink()
            else:
                path.write_text(original, encoding='utf-8')


if __name__ == '__main__':
    main()
