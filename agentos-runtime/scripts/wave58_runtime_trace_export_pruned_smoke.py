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


def archive_id_from_pruned(pruned_id):
    return pruned_id.rsplit('_pruned_', 1)[0]


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
    restore_pruned_id = f'wave58_restore_{stamp}_trace_20260617010101_pruned_{stamp}'
    delete_pruned_id = f'wave58_delete_{stamp}_trace_20260617010101_pruned_{stamp}'
    conflict_pruned_id = f'wave58_conflict_{stamp}_trace_20260617010101_pruned_{stamp}'
    restore_archive_id = archive_id_from_pruned(restore_pruned_id)
    conflict_archive_id = archive_id_from_pruned(conflict_pruned_id)

    restore_pruned_path = PRUNED_DIR / f'{restore_pruned_id}.md'
    delete_pruned_path = PRUNED_DIR / f'{delete_pruned_id}.md'
    conflict_pruned_path = PRUNED_DIR / f'{conflict_pruned_id}.md'
    restore_archive_path = ARCHIVE_DIR / f'{restore_archive_id}.md'
    conflict_archive_path = ARCHIVE_DIR / f'{conflict_archive_id}.md'
    all_paths = [restore_pruned_path, delete_pruned_path, conflict_pruned_path, restore_archive_path, conflict_archive_path]
    originals = file_snapshot(all_paths)
    ledger_before = file_snapshot(LEDGERS)
    try:
        write_file(restore_pruned_path, f'# Runtime Trace Export — wave58 restore {stamp}\n\nrestore pruned body\n')
        write_file(delete_pruned_path, f'# Runtime Trace Export — wave58 delete {stamp}\n\ndelete pruned body\n')
        write_file(conflict_pruned_path, f'# Runtime Trace Export — wave58 conflict {stamp}\n\nconflict pruned body\n')
        write_file(conflict_archive_path, f'# Runtime Trace Export — wave58 conflict existing {stamp}\n\nexisting archive body\n')

        index = api('/api/agent-worker/runtime-trace-export-pruned?limit=0')
        assert index['status'] == 'ok', index
        assert index['decision'] == 'runtime_trace_export_pruned_index', index
        pruned_ids = [item['pruned_id'] for item in index['pruned']]
        assert restore_pruned_id in pruned_ids, index
        assert delete_pruned_id in pruned_ids, index
        assert conflict_pruned_id in pruned_ids, index

        no_restore = api(f'/api/agent-worker/runtime-trace-export-pruned/{restore_pruned_id}/restore', method='POST', payload={'reason': 'smoke_no_confirm'})
        assert no_restore['status'] == 'runtime_trace_export_pruned_restore_confirmation_required', no_restore
        assert restore_pruned_path.exists() and not restore_archive_path.exists(), no_restore

        restored = api(f'/api/agent-worker/runtime-trace-export-pruned/{restore_pruned_id}/restore', method='POST', payload={'confirm_restore': True, 'reason': 'wave58_smoke_restore_pruned'})
        assert restored['status'] == 'runtime_trace_export_pruned_restored', restored
        assert restored['artifact_only_mutation'] is True, restored
        assert restored['operational_ledgers_mutated'] is False, restored
        assert not restore_pruned_path.exists(), restored
        assert restore_archive_path.exists(), restored
        assert 'restore pruned body' in restore_archive_path.read_text(encoding='utf-8'), restored

        conflict = api(f'/api/agent-worker/runtime-trace-export-pruned/{conflict_pruned_id}/restore', method='POST', payload={'confirm_restore': True, 'reason': 'wave58_smoke_conflict'})
        assert conflict['status'] == 'runtime_trace_export_pruned_restore_conflict', conflict
        assert conflict_pruned_path.exists(), conflict
        assert conflict_archive_path.exists(), conflict
        assert 'existing archive body' in conflict_archive_path.read_text(encoding='utf-8'), conflict

        wrong_delete = api(f'/api/agent-worker/runtime-trace-export-pruned/{delete_pruned_id}/delete', method='POST', payload={'confirm_delete': True, 'confirmation_phrase': 'wrong', 'reason': 'wave58_smoke_wrong_delete'})
        assert wrong_delete['status'] == 'runtime_trace_export_pruned_delete_confirmation_required', wrong_delete
        assert wrong_delete['required_phrase'] == f'DELETE PRUNED EXPORT {delete_pruned_id}', wrong_delete
        assert delete_pruned_path.exists(), wrong_delete

        deleted = api(f'/api/agent-worker/runtime-trace-export-pruned/{delete_pruned_id}/delete', method='POST', payload={'confirm_delete': True, 'confirmation_phrase': f'DELETE PRUNED EXPORT {delete_pruned_id}', 'reason': 'wave58_smoke_delete_pruned'})
        assert deleted['status'] == 'runtime_trace_export_pruned_deleted', deleted
        assert deleted['permanently_deleted'] is True, deleted
        assert deleted['artifact_only_mutation'] is True, deleted
        assert deleted['operational_ledgers_mutated'] is False, deleted
        assert not delete_pruned_path.exists(), deleted

        index_after = api('/api/agent-worker/runtime-trace-export-pruned?limit=0')
        pruned_after = [item['pruned_id'] for item in index_after['pruned']]
        assert restore_pruned_id not in pruned_after, index_after
        assert delete_pruned_id not in pruned_after, index_after
        assert conflict_pruned_id in pruned_after, index_after
        archive_index = api('/api/agent-worker/runtime-trace-export-archives?limit=0')
        archive_ids = [item['archive_id'] for item in archive_index['archives']]
        assert restore_archive_id in archive_ids, archive_index

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'pruned index/restore/delete must not mutate operational ledgers'

        html = text('/')
        markers = [
            'Pruned Trace Exports',
            'agentWorkerRuntimeTraceExportPruned',
            'loadAgentWorkerRuntimeTraceExportPruned',
            'restoreAgentWorkerRuntimeTraceExportPruned',
            'deleteAgentWorkerRuntimeTraceExportPruned',
            '/api/agent-worker/runtime-trace-export-pruned?limit=10',
            '/api/agent-worker/runtime-trace-export-pruned/${encodeURIComponent(prunedId)}/restore',
            '/api/agent-worker/runtime-trace-export-pruned/${encodeURIComponent(prunedId)}/delete',
            'confirm_restore: true',
            'confirm_delete: true',
            'DELETE PRUNED EXPORT',
            'Refresh pruned exports',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('pruned-index', index['status'], index['decision'], restore_pruned_id in pruned_ids, delete_pruned_id in pruned_ids, conflict_pruned_id in pruned_ids)
        print('pruned-restore-confirmation-required', no_restore['status'], no_restore['will_restore'])
        print('pruned-restored', restored['status'], restore_archive_path.exists(), restored['restore_archive_relpath'])
        print('pruned-restore-conflict', conflict['status'], conflict_pruned_path.exists(), conflict_archive_path.exists())
        print('pruned-delete-confirmation-required', wrong_delete['status'], wrong_delete['required_phrase'])
        print('pruned-deleted', deleted['status'], deleted['permanently_deleted'], not delete_pruned_path.exists())
        print('pruned-index-updated', restore_pruned_id not in pruned_after, delete_pruned_id not in pruned_after, conflict_pruned_id in pruned_after)
        print('archive-index-updated', restore_archive_id in archive_ids)
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


if __name__ == '__main__':
    main()
