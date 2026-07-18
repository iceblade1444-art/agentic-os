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
LEDGERS = [
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
]
EXPECTED_AGGRESSIVE = {'max_active': 3, 'max_archived': 10, 'older_than_days': 7}


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


def candidate_bytes(detail, key):
    return sum(int(candidate.get('size_bytes') or 0) for candidate in detail['candidates'].get(key, []))


def wait_ready():
    last = None
    for _ in range(30):
        try:
            status = api('/api/status')
            if status.get('workspace'):
                return status
        except Exception as exc:
            last = exc
            time.sleep(0.5)
    raise RuntimeError(f'dashboard not ready: {last}')


def main():
    status = wait_ready()
    baseline = api('/api/agent-worker/runtime-trace-export-retention/preset-impact/aggressive')
    assert baseline['status'] == 'runtime_trace_export_retention_preset_impact_found', baseline
    assert baseline['decision'] == 'runtime_trace_export_retention_preset_impact_detail', baseline
    assert baseline['dry_run'] is True and baseline['will_apply'] is False, baseline
    assert baseline['policy'] == EXPECTED_AGGRESSIVE, baseline
    assert baseline['candidates']['archive_candidates'] == baseline['preview']['archive_candidates'], baseline
    assert baseline['candidates']['prune_candidates'] == baseline['preview']['prune_candidates'], baseline

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    active_sizes = {idx: 10 + idx for idx in range(12)}
    archive_sizes = {idx: 20 + idx for idx in range(52)}
    temp_paths = []
    for idx in range(12):
        temp_paths.append(EXPORT_DIR / f'wave65_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(52):
        temp_paths.append(ARCHIVE_DIR / f'wave65_archive_{stamp}_{idx:02d}_trace_202606170202{idx:02d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)
    baseline_counts = dict(baseline['counts'])
    baseline_archive_bytes = baseline['archive_candidate_size_bytes']
    baseline_prune_bytes = baseline['prune_candidate_size_bytes']

    try:
        future_base = int(time.time()) + 1800
        for idx in range(12):
            write_artifact(EXPORT_DIR / f'wave65_active_{stamp}_{idx:02d}_trace.md', active_sizes[idx], future_base + idx)
        for idx in range(52):
            write_artifact(ARCHIVE_DIR / f'wave65_archive_{stamp}_{idx:02d}_trace_202606170202{idx:02d}.md', archive_sizes[idx], future_base + 100 + idx)

        detail = api('/api/agent-worker/runtime-trace-export-retention/preset-impact/aggressive')
        assert detail['status'] == 'runtime_trace_export_retention_preset_impact_found', detail
        assert detail['decision'] == 'runtime_trace_export_retention_preset_impact_detail', detail
        assert detail['preset_name'] == 'aggressive', detail
        assert detail['name'] == 'aggressive', detail
        assert detail['policy'] == EXPECTED_AGGRESSIVE, detail
        assert detail['preview_url'] == '/api/agent-worker/runtime-trace-export-retention/preview?max_active=3&max_archived=10&older_than_days=7', detail
        assert detail['candidates']['archive_candidates'] == detail['preview']['archive_candidates'], detail
        assert detail['candidates']['prune_candidates'] == detail['preview']['prune_candidates'], detail
        assert detail['archive_candidate_size_bytes'] == candidate_bytes(detail, 'archive_candidates'), detail
        assert detail['prune_candidate_size_bytes'] == candidate_bytes(detail, 'prune_candidates'), detail
        assert detail['total_candidate_size_bytes'] == detail['archive_candidate_size_bytes'] + detail['prune_candidate_size_bytes'], detail
        assert detail['archive_candidate_count'] >= baseline_counts['archive_candidates'] + 9, (baseline_counts, detail['counts'])
        assert detail['prune_candidate_count'] >= baseline_counts['prune_candidates'] + 42, (baseline_counts, detail['counts'])
        assert detail['archive_candidate_size_bytes'] >= baseline_archive_bytes + sum(active_sizes[idx] for idx in range(9)), detail
        assert detail['prune_candidate_size_bytes'] >= baseline_prune_bytes + sum(archive_sizes[idx] for idx in range(42)), detail
        assert detail['links'] == {
            'preset_impact': '/api/agent-worker/runtime-trace-export-retention/preset-impact',
            'presets': '/api/agent-worker/runtime-trace-export-retention/presets',
            'preview': detail['preview_url'],
            'recommended_preview': '/api/agent-worker/runtime-trace-export-retention/recommended-preview',
            'retention_apply': '/api/agent-worker/runtime-trace-export-retention/apply',
        }, detail

        unknown = api('/api/agent-worker/runtime-trace-export-retention/preset-impact/unknown')
        assert unknown['status'] == 'runtime_trace_export_retention_preset_impact_not_found', unknown
        assert unknown['decision'] == 'runtime_trace_export_retention_preset_impact_detail', unknown
        assert unknown['impact'] is None, unknown
        assert unknown['candidates'] == {'archive_candidates': [], 'prune_candidates': []}, unknown

        matrix = api('/api/agent-worker/runtime-trace-export-retention/preset-impact')
        aggressive_row = [row for row in matrix['impacts'] if row['name'] == 'aggressive'][0]
        assert aggressive_row['archive_candidate_count'] == detail['archive_candidate_count'], (aggressive_row, detail)
        assert aggressive_row['prune_candidate_count'] == detail['prune_candidate_count'], (aggressive_row, detail)
        assert aggressive_row['total_candidate_size_bytes'] == detail['total_candidate_size_bytes'], (aggressive_row, detail)

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'preset impact detail must not mutate operational ledgers'
        assert all(path.exists() for path in temp_paths), 'preset impact detail must not move/delete artifacts'

        html = text('/')
        markers = [
            'View impact',
            'showAgentWorkerRuntimeTraceExportRetentionPresetImpactDetail',
            '/api/agent-worker/runtime-trace-export-retention/preset-impact/${encodeURIComponent(name)}',
            'runtime_trace_export_retention_preset_impact_detail',
            'archive_candidates',
            'prune_candidates',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('preset-impact-detail', detail['status'], detail['decision'], detail['dry_run'], detail['will_apply'])
        print('detail-policy', detail['preset_name'], detail['policy'], detail['preview_url'])
        print('detail-counts', detail['counts'])
        print('detail-bytes', {'archive_candidate_size_bytes': detail['archive_candidate_size_bytes'], 'prune_candidate_size_bytes': detail['prune_candidate_size_bytes'], 'total_candidate_size_bytes': detail['total_candidate_size_bytes']})
        print('detail-candidates-match-preview', detail['candidates']['archive_candidates'] == detail['preview']['archive_candidates'], detail['candidates']['prune_candidates'] == detail['preview']['prune_candidates'])
        print('unknown-preset', unknown['status'], unknown['decision'], unknown['impact'], unknown['candidates'])
        print('matrix-detail-match', aggressive_row['total_candidate_size_bytes'] == detail['total_candidate_size_bytes'])
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
