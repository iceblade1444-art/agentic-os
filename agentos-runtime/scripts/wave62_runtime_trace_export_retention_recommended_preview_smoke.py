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
    with request.urlopen(BASE + path, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))


def text(path):
    with request.urlopen(BASE + path, timeout=15) as resp:
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
    temp_paths = []
    future_base = int(time.time()) + 900
    for idx in range(12):
        temp_paths.append(EXPORT_DIR / f'wave62_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(52):
        temp_paths.append(ARCHIVE_DIR / f'wave62_archive_{stamp}_{idx:02d}_trace_202606170101{idx:02d}.md')
    for idx in range(3):
        temp_paths.append(PRUNED_DIR / f'wave62_pruned_{stamp}_{idx:02d}_trace_202606170101{idx:02d}_pruned_{stamp}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)
    before = api('/api/agent-worker/runtime-trace-export-retention/recommended-preview')
    before_est = before['recommendations']['estimated_actions']

    try:
        for idx in range(12):
            write_artifact(EXPORT_DIR / f'wave62_active_{stamp}_{idx:02d}_trace.md', f'wave62-active-{idx}', future_base + idx)
        for idx in range(52):
            write_artifact(ARCHIVE_DIR / f'wave62_archive_{stamp}_{idx:02d}_trace_202606170101{idx:02d}.md', f'wave62-archive-{idx}', future_base + 100 + idx)
        for idx in range(3):
            write_artifact(PRUNED_DIR / f'wave62_pruned_{stamp}_{idx:02d}_trace_202606170101{idx:02d}_pruned_{stamp}.md', f'wave62-pruned-{idx}', future_base + 200 + idx)

        bundle = api('/api/agent-worker/runtime-trace-export-retention/recommended-preview')
        recommendations = api('/api/agent-worker/runtime-trace-export-retention/recommendations')
        preview = api('/api/agent-worker/runtime-trace-export-retention/preview?max_active=10&max_archived=50&older_than_days=30')

        assert bundle['status'] == 'ok', bundle
        assert bundle['decision'] == 'runtime_trace_export_retention_recommended_preview', bundle
        assert bundle['dry_run'] is True and bundle['will_apply'] is False, bundle
        assert bundle['recommended_policy'] == {'max_active': 10, 'max_archived': 50, 'older_than_days': 30}, bundle
        assert bundle['preview']['decision'] == 'runtime_trace_export_retention_preview', bundle
        assert bundle['preview']['policy'] == bundle['recommended_policy'], bundle
        assert bundle['storage_summary']['decision'] == 'runtime_trace_export_storage_summary', bundle
        assert bundle['recommendations']['decision'] == 'runtime_trace_export_retention_recommendations', bundle
        assert bundle['recommendations']['severity'] == 'action_recommended', bundle
        assert bundle['operator_next_steps'] == ['review_archive_candidates', 'review_prune_candidates', 'apply_retention_requires_confirm_retention_true'], bundle
        assert bundle['preview']['counts'] == preview['counts'], bundle
        assert bundle['recommendations']['estimated_actions'] == recommendations['estimated_actions'], bundle
        after_est = bundle['recommendations']['estimated_actions']
        assert after_est['archive_candidates'] >= before_est['archive_candidates'] + 2, (before_est, after_est)
        assert after_est['prune_candidates'] >= before_est['prune_candidates'] + 2, (before_est, after_est)
        assert after_est['total_candidates'] == after_est['archive_candidates'] + after_est['prune_candidates'], after_est
        assert bundle['links']['recommendations'] == '/api/agent-worker/runtime-trace-export-retention/recommendations', bundle
        assert bundle['links']['retention_apply'] == '/api/agent-worker/runtime-trace-export-retention/apply', bundle

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'recommended preview must not mutate operational ledgers'
        assert all(path.exists() for path in temp_paths), 'recommended preview must not move/delete artifacts'

        html = text('/')
        markers = [
            'Recommended Retention Preview',
            'loadAgentWorkerRuntimeTraceExportRecommendedPreview',
            '/api/agent-worker/runtime-trace-export-retention/recommended-preview',
            'runtime_trace_export_retention_recommended_preview',
            'operator_next_steps',
            'review_archive_candidates',
            'review_prune_candidates',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('recommended-preview', bundle['status'], bundle['decision'], bundle['dry_run'], bundle['will_apply'])
        print('recommended-policy', bundle['recommended_policy'])
        print('estimated-actions', after_est)
        print('operator-next-steps', bundle['operator_next_steps'])
        print('preview-counts-match', bundle['preview']['counts'] == preview['counts'])
        print('recommendations-match', bundle['recommendations']['estimated_actions'] == recommendations['estimated_actions'])
        print('storage-counts', bundle['storage_summary']['totals'])
        print('read-only', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('artifacts-preserved', all(path.exists() for path in temp_paths))
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
