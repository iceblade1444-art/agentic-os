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
PRUNED_DIR = EXPORT_DIR / 'pruned'
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


def write_artifact(path, content, mtime):
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
    active_path = EXPORT_DIR / f'wave60_active_{stamp}_trace.md'
    archive_path = ARCHIVE_DIR / f'wave60_archive_{stamp}_trace_20260617010101.md'
    pruned_path = PRUNED_DIR / f'wave60_pruned_{stamp}_trace_20260617010101_pruned_{stamp}.md'
    temp_paths = [active_path, archive_path, pruned_path]
    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)
    before = api('/api/agent-worker/runtime-trace-export-storage-summary')

    try:
        future_mtime = int(time.time()) + 600
        active_content = 'wave60-active-storage-summary'
        archive_content = 'wave60-archive-storage-summary-longer'
        pruned_content = 'wave60-pruned-storage-summary-longest-value'
        write_artifact(active_path, active_content, future_mtime)
        write_artifact(archive_path, archive_content, future_mtime + 1)
        write_artifact(pruned_path, pruned_content, future_mtime + 2)

        summary = api('/api/agent-worker/runtime-trace-export-storage-summary')
        assert summary['status'] == 'ok', summary
        assert summary['decision'] == 'runtime_trace_export_storage_summary', summary
        assert summary['dry_run'] is True and summary['will_apply'] is False, summary
        assert summary['links']['active_index'] == '/api/agent-worker/runtime-trace-exports?limit=20', summary
        assert summary['links']['archive_index'] == '/api/agent-worker/runtime-trace-export-archives?limit=20', summary
        assert summary['links']['pruned_index'] == '/api/agent-worker/runtime-trace-export-pruned?limit=20', summary
        assert summary['links']['retention_preview'].startswith('/api/agent-worker/runtime-trace-export-retention/preview'), summary
        dirs = summary['directories']
        assert dirs['active']['pattern'] == '*_trace.md', summary
        assert dirs['archive']['pattern'] == '*_trace_*.md', summary
        assert dirs['pruned']['pattern'] == '*_pruned_*.md', summary
        assert dirs['active']['newest_relpath'] == active_path.relative_to(ROOT).as_posix(), summary
        assert dirs['archive']['newest_relpath'] == archive_path.relative_to(ROOT).as_posix(), summary
        assert dirs['pruned']['newest_relpath'] == pruned_path.relative_to(ROOT).as_posix(), summary
        assert summary['totals']['active_count'] >= before['totals']['active_count'] + 1, summary
        assert summary['totals']['archive_count'] >= before['totals']['archive_count'] + 1, summary
        assert summary['totals']['pruned_count'] >= before['totals']['pruned_count'] + 1, summary
        assert summary['totals']['count'] >= before['totals']['count'] + 3, summary
        assert summary['totals']['total_size_bytes'] >= before['totals']['total_size_bytes'] + len(active_content) + len(archive_content) + len(pruned_content), summary

        # Existing indexes should still see their own classes after the storage summary read.
        active_index = api('/api/agent-worker/runtime-trace-exports?limit=0')
        archive_index = api('/api/agent-worker/runtime-trace-export-archives?limit=0')
        pruned_index = api('/api/agent-worker/runtime-trace-export-pruned?limit=0')
        assert active_path.name in [item['filename'] for item in active_index['exports']], active_index
        assert archive_path.name in [item['filename'] for item in archive_index['archives']], archive_index
        assert pruned_path.name in [item['filename'] for item in pruned_index['pruned']], pruned_index

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'storage summary must not mutate operational ledgers'
        assert active_path.read_text(encoding='utf-8') == active_content
        assert archive_path.read_text(encoding='utf-8') == archive_content
        assert pruned_path.read_text(encoding='utf-8') == pruned_content

        html = text('/')
        markers = [
            'Runtime Trace Export Storage',
            'agentWorkerRuntimeTraceExportStorageSummary',
            'loadAgentWorkerRuntimeTraceExportStorageSummary',
            '/api/agent-worker/runtime-trace-export-storage-summary',
            'runtime_trace_export_storage_summary',
            'active_count',
            'archive_count',
            'pruned_count',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('storage-summary', summary['status'], summary['decision'], summary['dry_run'], summary['will_apply'])
        print('storage-counts', summary['totals']['active_count'], summary['totals']['archive_count'], summary['totals']['pruned_count'], summary['totals']['total_size_bytes'])
        print('storage-newest', dirs['active']['newest_relpath'], dirs['archive']['newest_relpath'], dirs['pruned']['newest_relpath'])
        print('indexes-still-work', active_path.name in [item['filename'] for item in active_index['exports']], archive_path.name in [item['filename'] for item in archive_index['archives']], pruned_path.name in [item['filename'] for item in pruned_index['pruned']])
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
