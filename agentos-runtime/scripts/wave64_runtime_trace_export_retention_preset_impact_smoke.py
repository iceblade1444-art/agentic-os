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
EXPECTED_POLICIES = {
    'conservative': {'max_active': 25, 'max_archived': 100, 'older_than_days': 90},
    'standard': {'max_active': 10, 'max_archived': 50, 'older_than_days': 30},
    'aggressive': {'max_active': 3, 'max_archived': 10, 'older_than_days': 7},
}


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


def write_artifact(path, size, mtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('x' * size, encoding='utf-8')
    os.utime(path, (mtime, mtime))


def by_name(payload):
    return {impact['name']: impact for impact in payload['impacts']}


def candidate_bytes_from_preview(impact, key):
    return sum(int(candidate.get('size_bytes') or 0) for candidate in impact['preview'].get(key, []))


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

    before = api('/api/agent-worker/runtime-trace-export-retention/preset-impact')
    assert before['status'] == 'ok', before
    assert before['decision'] == 'runtime_trace_export_retention_preset_impact', before
    assert before['dry_run'] is True and before['will_apply'] is False, before
    assert before['preset_names'] == ['conservative', 'standard', 'aggressive'], before
    before_by_name = by_name(before)
    assert {name: impact['policy'] for name, impact in before_by_name.items()} == EXPECTED_POLICIES, before

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    future_base = int(time.time()) + 1500
    for idx in range(12):
        temp_paths.append(EXPORT_DIR / f'wave64_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(52):
        temp_paths.append(ARCHIVE_DIR / f'wave64_archive_{stamp}_{idx:02d}_trace_202606170101{idx:02d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)

    try:
        for idx in range(12):
            write_artifact(EXPORT_DIR / f'wave64_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(52):
            write_artifact(ARCHIVE_DIR / f'wave64_archive_{stamp}_{idx:02d}_trace_202606170101{idx:02d}.md', 20 + idx, future_base + 100 + idx)

        impact = api('/api/agent-worker/runtime-trace-export-retention/preset-impact')
        presets = api('/api/agent-worker/runtime-trace-export-retention/presets')
        assert impact['status'] == 'ok', impact
        assert impact['decision'] == 'runtime_trace_export_retention_preset_impact', impact
        assert impact['dry_run'] is True and impact['will_apply'] is False, impact
        assert impact['matrix_columns'] == [
            'preset', 'max_active', 'max_archived', 'older_than_days',
            'archive_candidates', 'prune_candidates', 'total_candidates',
            'archive_candidate_size_bytes', 'prune_candidate_size_bytes', 'total_candidate_size_bytes'
        ], impact
        assert impact['storage_summary']['decision'] == 'runtime_trace_export_storage_summary', impact
        by = by_name(impact)
        preset_urls = {preset['name']: preset['preview_url'] for preset in presets['presets']}
        assert by.keys() == before_by_name.keys(), impact
        for name, row in by.items():
            assert row['policy'] == EXPECTED_POLICIES[name], row
            assert row['preview_url'] == preset_urls[name], row
            assert row['preview']['decision'] == 'runtime_trace_export_retention_preview', row
            assert row['counts'] == row['preview']['counts'], row
            assert row['archive_candidate_size_bytes'] == candidate_bytes_from_preview(row, 'archive_candidates'), row
            assert row['prune_candidate_size_bytes'] == candidate_bytes_from_preview(row, 'prune_candidates'), row
            assert row['total_candidate_size_bytes'] == row['archive_candidate_size_bytes'] + row['prune_candidate_size_bytes'], row
            assert row['dry_run'] is True and row['will_apply'] is False, row

        assert by['standard']['archive_candidate_count'] >= before_by_name['standard']['archive_candidate_count'] + 2, (before_by_name['standard'], by['standard'])
        assert by['standard']['prune_candidate_count'] >= before_by_name['standard']['prune_candidate_count'] + 2, (before_by_name['standard'], by['standard'])
        assert by['aggressive']['archive_candidate_count'] >= before_by_name['aggressive']['archive_candidate_count'] + 9, (before_by_name['aggressive'], by['aggressive'])
        assert by['aggressive']['prune_candidate_count'] >= before_by_name['aggressive']['prune_candidate_count'] + 42, (before_by_name['aggressive'], by['aggressive'])
        assert any(row['highest_impact'] for row in by.values()), by
        assert impact['totals']['max_total_candidates'] == max(row['total_candidate_count'] for row in by.values()), impact
        assert impact['totals']['max_total_candidate_size_bytes'] == max(row['total_candidate_size_bytes'] for row in by.values()), impact

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'preset impact must not mutate operational ledgers'
        assert all(path.exists() for path in temp_paths), 'preset impact must not move/delete artifacts'

        html = text('/')
        markers = [
            'Retention Preset Impact',
            'agentWorkerRuntimeTraceExportRetentionPresetImpact',
            'loadAgentWorkerRuntimeTraceExportRetentionPresetImpact',
            '/api/agent-worker/runtime-trace-export-retention/preset-impact',
            'runtime_trace_export_retention_preset_impact',
            'archive_candidate_size_bytes',
            'prune_candidate_size_bytes',
            'highest_impact',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('preset-impact', impact['status'], impact['decision'], impact['dry_run'], impact['will_apply'])
        print('preset-names', impact['preset_names'], 'default', impact['default_preset'])
        print('matrix-columns', ','.join(impact['matrix_columns']))
        print('impact-counts', {name: row['counts'] for name, row in by.items()})
        print('impact-bytes', {name: {'archive_candidate_size_bytes': row['archive_candidate_size_bytes'], 'prune_candidate_size_bytes': row['prune_candidate_size_bytes'], 'total_candidate_size_bytes': row['total_candidate_size_bytes'], 'highest_impact': row['highest_impact']} for name, row in by.items()})
        print('impact-totals', impact['totals'])
        print('storage-counts', impact['storage_summary']['totals'])
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
