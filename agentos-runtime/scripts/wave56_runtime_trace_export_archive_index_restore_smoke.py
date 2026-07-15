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


def write_archive(one_shot_run_id, stamp):
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    archive_id = f'{one_shot_run_id}_trace_{stamp}'
    path = ARCHIVE_DIR / f'{archive_id}.md'
    content = (
        f'# Runtime Trace Export — {one_shot_run_id}\n\n'
        '## Archived Smoke\n'
        '- artifact_only_mutation: true\n'
        '- operational_ledgers_mutated: false\n'
    )
    path.write_text(content, encoding='utf-8')
    os.utime(path, (int(time.time()) + 100, int(time.time()) + 100))
    return archive_id, path, content


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
    one_shot_run_id = f'wave56_smoke_{stamp}'
    active_path = EXPORT_DIR / f'{one_shot_run_id}_trace.md'
    archive_id, archive_path, archive_content = write_archive(one_shot_run_id, stamp)
    original_active = active_path.read_text(encoding='utf-8') if active_path.exists() else None
    original_archive = archive_path.read_text(encoding='utf-8') if archive_path.exists() else None
    ledger_before = file_snapshot(LEDGERS)
    try:
        index_before = api('/api/agent-worker/runtime-trace-export-archives?limit=0')
        assert index_before['status'] == 'ok', index_before
        assert index_before['decision'] == 'runtime_trace_export_archive_index', index_before
        archive_ids = [item['archive_id'] for item in index_before['archives']]
        assert archive_id in archive_ids, index_before
        entry = next(item for item in index_before['archives'] if item['archive_id'] == archive_id)
        assert entry['one_shot_run_id'] == one_shot_run_id, entry
        assert entry['restore_relpath'] == f'artifacts/agent-worker/runtime-traces/{one_shot_run_id}_trace.md', entry

        no_confirm = api(
            f'/api/agent-worker/runtime-trace-export-archives/{archive_id}/restore',
            method='POST',
            payload={'reason': 'smoke_without_confirm'},
        )
        assert no_confirm['status'] == 'runtime_trace_export_restore_confirmation_required', no_confirm
        assert no_confirm['will_restore'] is False, no_confirm
        assert archive_path.exists(), no_confirm
        assert not active_path.exists(), no_confirm

        restored = api(
            f'/api/agent-worker/runtime-trace-export-archives/{archive_id}/restore',
            method='POST',
            payload={'confirm_restore': True, 'reason': 'wave56_smoke_restore'},
        )
        assert restored['status'] == 'runtime_trace_export_restored', restored
        assert restored['decision'] == 'runtime_trace_export_restore', restored
        assert restored['artifact_only_mutation'] is True, restored
        assert restored['operational_ledgers_mutated'] is False, restored
        assert not archive_path.exists(), restored
        assert active_path.exists(), restored
        assert active_path.read_text(encoding='utf-8') == archive_content, restored

        active_detail = api(f'/api/agent-worker/runtime-trace-exports/{one_shot_run_id}')
        assert active_detail['status'] == 'runtime_trace_export_found', active_detail
        index_after_restore = api('/api/agent-worker/runtime-trace-export-archives?limit=0')
        assert archive_id not in [item['archive_id'] for item in index_after_restore['archives']], index_after_restore

        missing = api(
            f'/api/agent-worker/runtime-trace-export-archives/{one_shot_run_id}_missing_trace_{stamp}/restore',
            method='POST',
            payload={'confirm_restore': True, 'reason': 'missing'},
        )
        assert missing['status'] == 'runtime_trace_export_restore_not_found', missing

        # Recreate archive while active export exists to verify conflict is a no-op.
        archive_id_conflict, archive_path_conflict, conflict_content = write_archive(one_shot_run_id, stamp + '_conflict')
        conflict = api(
            f'/api/agent-worker/runtime-trace-export-archives/{archive_id_conflict}/restore',
            method='POST',
            payload={'confirm_restore': True, 'reason': 'conflict'},
        )
        assert conflict['status'] == 'runtime_trace_export_restore_conflict', conflict
        assert conflict['will_restore'] is False, conflict
        assert archive_path_conflict.exists(), conflict
        assert archive_path_conflict.read_text(encoding='utf-8') == conflict_content, conflict
        assert active_path.read_text(encoding='utf-8') == archive_content, conflict

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'archive index/restore must not mutate operational ledgers'

        html = text('/')
        markers = [
            'Archived Trace Exports',
            'agentWorkerRuntimeTraceExportArchives',
            'loadAgentWorkerRuntimeTraceExportArchives',
            '/api/agent-worker/runtime-trace-export-archives?limit=10',
            'restoreAgentWorkerRuntimeTraceExportArchive',
            '/api/agent-worker/runtime-trace-export-archives/${encodeURIComponent(archiveId)}/restore',
            'confirm(`Restore archived runtime trace export',
            'confirm_restore: true',
            'Restore export',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('archive-index', index_before['status'], index_before['decision'], archive_id in archive_ids)
        print('restore-confirmation-required', no_confirm['status'], no_confirm['will_restore'])
        print('restore-success', restored['status'], restored['one_shot_run_id'], restored['restore_relpath'])
        print('active-detail-after-restore', active_detail['status'])
        print('archive-index-after-restore-missing-id', archive_id not in [item['archive_id'] for item in index_after_restore['archives']])
        print('restore-missing', missing['status'])
        print('restore-conflict', conflict['status'], archive_path_conflict.exists())
        print('read-only', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        conflict_candidate = ARCHIVE_DIR / f'{one_shot_run_id}_trace_{stamp}_conflict.md'
        if conflict_candidate.exists():
            conflict_candidate.unlink()
        if original_archive is None:
            if archive_path.exists():
                archive_path.unlink()
        else:
            archive_path.parent.mkdir(parents=True, exist_ok=True)
            archive_path.write_text(original_archive, encoding='utf-8')
        if original_active is None:
            if active_path.exists():
                active_path.unlink()
        else:
            active_path.parent.mkdir(parents=True, exist_ok=True)
            active_path.write_text(original_active, encoding='utf-8')


if __name__ == '__main__':
    main()
