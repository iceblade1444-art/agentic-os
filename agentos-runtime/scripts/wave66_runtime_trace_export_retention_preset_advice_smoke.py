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
EXPECTED_CONSERVATIVE = {'max_active': 25, 'max_archived': 100, 'older_than_days': 90}


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


def guidance_by_name(advice):
    return {item['name']: item for item in advice.get('preset_guidance', [])}


def main():
    status = wait_ready()
    baseline = api('/api/agent-worker/runtime-trace-export-retention/preset-advice')
    assert baseline['status'] == 'ok', baseline
    assert baseline['decision'] == 'runtime_trace_export_retention_preset_advice', baseline
    assert baseline['dry_run'] is True and baseline['will_apply'] is False, baseline

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    for idx in range(30):
        temp_paths.append(EXPORT_DIR / f'wave66_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(110):
        temp_paths.append(ARCHIVE_DIR / f'wave66_archive_{stamp}_{idx:03d}_trace_202606170404{idx:03d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)

    try:
        future_base = int(time.time()) + 2200
        for idx in range(30):
            write_artifact(EXPORT_DIR / f'wave66_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(110):
            write_artifact(ARCHIVE_DIR / f'wave66_archive_{stamp}_{idx:03d}_trace_202606170404{idx:03d}.md', 20 + idx, future_base + 100 + idx)

        advice = api('/api/agent-worker/runtime-trace-export-retention/preset-advice')
        assert advice['status'] == 'ok', advice
        assert advice['decision'] == 'runtime_trace_export_retention_preset_advice', advice
        assert advice['dry_run'] is True and advice['will_apply'] is False, advice
        assert advice['recommended_preset'] == 'conservative', advice
        assert advice['recommended_policy'] == EXPECTED_CONSERVATIVE, advice
        assert advice['recommended_action'] == 'review_retention_preview', advice
        assert advice['severity'] == 'action_recommended', advice
        assert advice['reason_codes'] == [
            'preset_impact_matrix_evaluated',
            'conservative_has_candidates_safest_action',
            'retention_apply_requires_confirm_retention_true',
        ], advice
        assert advice['recommended_impact']['name'] == 'conservative', advice
        assert advice['recommended_impact']['archive_candidate_count'] >= 5, advice
        assert advice['recommended_impact']['prune_candidate_count'] >= 10, advice
        assert advice['impact_matrix']['decision'] == 'runtime_trace_export_retention_preset_impact', advice
        assert advice['links']['recommended_impact_detail'] == '/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative', advice
        assert advice['links']['recommended_preview'] == '/api/agent-worker/runtime-trace-export-retention/preview?max_active=25&max_archived=100&older_than_days=90', advice
        assert advice['operator_next_steps'] == [
            'review_conservative_impact_detail',
            'preview_conservative_retention',
            'apply_retention_requires_confirm_retention_true',
        ], advice
        assert advice['safety'] == {
            'read_only': True,
            'retention_apply_called': False,
            'history_writes_enabled': False,
            'operational_ledgers_mutated': False,
        }, advice
        guidance = guidance_by_name(advice)
        assert guidance['conservative']['guidance_level'] == 'recommended', guidance
        assert guidance['standard']['guidance_level'] == 'more_aggressive_than_recommended', guidance
        assert guidance['aggressive']['guidance_level'] == 'higher_churn_available', guidance

        detail = api('/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative')
        assert detail['status'] == 'runtime_trace_export_retention_preset_impact_found', detail
        assert detail['total_candidate_size_bytes'] == advice['recommended_impact']['total_candidate_size_bytes'], (detail, advice['recommended_impact'])

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'preset advice must not mutate operational ledgers'
        assert all(path.exists() for path in temp_paths), 'preset advice must not move/delete artifacts'

        html = text('/')
        markers = [
            'Retention Preset Advice',
            'agentWorkerRuntimeTraceExportRetentionPresetAdvice',
            'loadAgentWorkerRuntimeTraceExportRetentionPresetAdvice',
            '/api/agent-worker/runtime-trace-export-retention/preset-advice',
            'runtime_trace_export_retention_preset_advice',
            'recommended_preset',
            'reason_codes',
            'operator_next_steps',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('preset-advice', advice['status'], advice['decision'], advice['dry_run'], advice['will_apply'])
        print('recommended', advice['recommended_preset'], advice['recommended_action'], advice['severity'], advice['recommended_policy'])
        print('reason-codes', advice['reason_codes'])
        print('recommended-impact', {'archive_candidate_count': advice['recommended_impact']['archive_candidate_count'], 'prune_candidate_count': advice['recommended_impact']['prune_candidate_count'], 'total_candidate_size_bytes': advice['recommended_impact']['total_candidate_size_bytes']})
        print('guidance', {name: row['guidance_level'] for name, row in guidance.items()})
        print('operator-next-steps', advice['operator_next_steps'])
        print('detail-match', detail['total_candidate_size_bytes'] == advice['recommended_impact']['total_candidate_size_bytes'])
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
