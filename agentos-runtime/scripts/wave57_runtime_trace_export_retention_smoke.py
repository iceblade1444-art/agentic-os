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
OLD_EPOCH = 946684800  # 2000-01-01 UTC; older_than_days=9000 selects only this smoke artifact in normal dev workspaces.


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
    active_id = f'wave57_active_{stamp}'
    archive_one_shot = f'wave57_archived_{stamp}'
    archive_id = f'{archive_one_shot}_trace_{stamp}'
    active_path = EXPORT_DIR / f'{active_id}_trace.md'
    archive_path = ARCHIVE_DIR / f'{archive_id}.md'
    original_paths = [active_path, archive_path]
    originals = file_snapshot(original_paths)
    ledger_before = file_snapshot(LEDGERS)
    moved_archive_path = None
    moved_pruned_path = None
    try:
        active_content = f'# Runtime Trace Export — {active_id}\n\nwave57 active old\n'
        archive_content = f'# Runtime Trace Export — {archive_one_shot}\n\nwave57 archived old\n'
        write_file(active_path, active_content)
        write_file(archive_path, archive_content)

        preview = api('/api/agent-worker/runtime-trace-export-retention/preview?older_than_days=9000')
        assert preview['status'] == 'ok', preview
        assert preview['decision'] == 'runtime_trace_export_retention_preview', preview
        assert preview['dry_run'] is True, preview
        active_candidates = [item for item in preview['archive_candidates'] if item['one_shot_run_id'] == active_id]
        prune_candidates = [item for item in preview['prune_candidates'] if item['archive_id'] == archive_id]
        assert len(active_candidates) == 1, preview
        assert len(prune_candidates) == 1, preview
        assert active_path.exists(), preview
        assert archive_path.exists(), preview
        assert not PRUNED_DIR.exists() or not any(PRUNED_DIR.glob(f'{archive_id}_pruned_*.md')), preview

        no_confirm = api('/api/agent-worker/runtime-trace-export-retention/apply', method='POST', payload={'older_than_days': 9000, 'reason': 'smoke_without_confirm'})
        assert no_confirm['status'] == 'runtime_trace_export_retention_confirmation_required', no_confirm
        assert no_confirm['will_apply'] is False, no_confirm
        assert active_path.exists(), no_confirm
        assert archive_path.exists(), no_confirm

        applied = api('/api/agent-worker/runtime-trace-export-retention/apply', method='POST', payload={'older_than_days': 9000, 'confirm_retention': True, 'reason': 'wave57_smoke_retention'})
        assert applied['status'] == 'runtime_trace_export_retention_applied', applied
        assert applied['decision'] == 'runtime_trace_export_retention_apply', applied
        assert applied['artifact_only_mutation'] is True, applied
        assert applied['operational_ledgers_mutated'] is False, applied
        archived_rows = [item for item in applied['archived'] if item['one_shot_run_id'] == active_id]
        pruned_rows = [item for item in applied['pruned'] if item['archive_id'] == archive_id]
        assert len(archived_rows) == 1, applied
        assert len(pruned_rows) == 1, applied
        moved_archive_path = Path(archived_rows[0]['archive_path'])
        moved_pruned_path = Path(pruned_rows[0]['pruned_path'])
        assert not active_path.exists(), applied
        assert moved_archive_path.exists(), applied
        assert moved_archive_path.read_text(encoding='utf-8') == active_content, applied
        assert not archive_path.exists(), applied
        assert moved_pruned_path.exists(), applied
        assert moved_pruned_path.read_text(encoding='utf-8') == archive_content, applied

        active_detail = api(f'/api/agent-worker/runtime-trace-exports/{active_id}')
        assert active_detail['status'] == 'runtime_trace_export_not_found', active_detail
        archive_index = api('/api/agent-worker/runtime-trace-export-archives?limit=0')
        assert any(item['one_shot_run_id'] == active_id for item in archive_index['archives']), archive_index
        assert archive_id not in [item['archive_id'] for item in archive_index['archives']], archive_index

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'retention preview/apply must not mutate operational ledgers'

        html = text('/')
        markers = [
            'Runtime Trace Export Retention',
            'agentWorkerRuntimeTraceExportRetention',
            'previewAgentWorkerRuntimeTraceExportRetention',
            'applyAgentWorkerRuntimeTraceExportRetention',
            '/api/agent-worker/runtime-trace-export-retention/preview',
            '/api/agent-worker/runtime-trace-export-retention/apply',
            'confirm(`Apply runtime trace export retention',
            'confirm_retention: true',
            'Retention preview',
            'Apply retention',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('retention-preview', preview['status'], preview['decision'], len(active_candidates), len(prune_candidates))
        print('retention-confirmation-required', no_confirm['status'], no_confirm['will_apply'])
        print('retention-applied', applied['status'], active_id, archive_id)
        print('active-archived', moved_archive_path.exists(), moved_archive_path.relative_to(ROOT).as_posix())
        print('archive-pruned', moved_pruned_path.exists(), moved_pruned_path.relative_to(ROOT).as_posix())
        print('active-detail-after-retention', active_detail['status'])
        print('archive-index-updated', any(item['one_shot_run_id'] == active_id for item in archive_index['archives']), archive_id not in [item['archive_id'] for item in archive_index['archives']])
        print('read-only', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        for path, original in originals.items():
            path = Path(path)
            if original is None:
                if path.exists():
                    path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(original, encoding='utf-8')
        for path in [moved_archive_path, moved_pruned_path]:
            if path and path.exists():
                path.unlink()


if __name__ == '__main__':
    main()
