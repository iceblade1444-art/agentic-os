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
HISTORY = ROOT / 'logs' / 'agent-worker' / 'retention-preset-advice-history.json'
LEDGERS = [
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
    HISTORY,
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


def main():
    status = wait_ready()
    baseline = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview')
    assert baseline['status'] == 'ok', baseline
    assert baseline['decision'] == 'runtime_trace_export_retention_preset_advice_audit_preview', baseline
    assert baseline['writes_enabled'] is False, baseline

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    for idx in range(30):
        temp_paths.append(EXPORT_DIR / f'wave67_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(110):
        temp_paths.append(ARCHIVE_DIR / f'wave67_archive_{stamp}_{idx:03d}_trace_202606170606{idx:03d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)

    try:
        future_base = int(time.time()) + 2600
        for idx in range(30):
            write_artifact(EXPORT_DIR / f'wave67_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(110):
            write_artifact(ARCHIVE_DIR / f'wave67_archive_{stamp}_{idx:03d}_trace_202606170606{idx:03d}.md', 20 + idx, future_base + 100 + idx)

        preview = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview')
        assert preview['status'] == 'ok', preview
        assert preview['decision'] == 'runtime_trace_export_retention_preset_advice_audit_preview', preview
        assert preview['dry_run'] is True and preview['will_apply'] is False, preview
        assert preview['writes_enabled'] is False, preview
        assert preview['history'] == {
            'status': 'not_recorded',
            'records': [],
            'writes_enabled': False,
            'reason': 'retention_preset_advice_audit_preview_is_read_only',
        }, preview
        record = preview['would_record']
        assert record['record_type'] == 'retention_preset_advice', record
        assert record['status'] == 'would_record', record
        assert record['writes_enabled'] is False, record
        assert record['recommended_preset'] == 'conservative', record
        assert record['recommended_policy'] == EXPECTED_CONSERVATIVE, record
        assert record['recommended_action'] == 'review_retention_preview', record
        assert record['severity'] == 'action_recommended', record
        assert record['reason_codes'] == [
            'preset_impact_matrix_evaluated',
            'conservative_has_candidates_safest_action',
            'retention_apply_requires_confirm_retention_true',
        ], record
        assert record['operator_next_steps'] == [
            'review_conservative_impact_detail',
            'preview_conservative_retention',
            'apply_retention_requires_confirm_retention_true',
        ], record
        assert record['recommended_impact_summary']['archive_candidate_count'] >= 5, record
        assert record['recommended_impact_summary']['prune_candidate_count'] >= 10, record
        assert record['safety'] == {
            'read_only': True,
            'retention_apply_called': False,
            'history_writes_enabled': False,
            'operational_ledgers_mutated': False,
        }, record
        assert preview['advice']['recommended_preset'] == record['recommended_preset'], preview
        assert preview['advice']['recommended_impact']['total_candidate_size_bytes'] == record['recommended_impact_summary']['total_candidate_size_bytes'], preview
        assert preview['links']['recommended_impact_detail'] == '/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative', preview

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'audit preview must not mutate operational/history ledgers'
        assert all(path.exists() for path in temp_paths), 'audit preview must not move/delete artifacts'

        html = text('/')
        markers = [
            'Retention Preset Advice Audit Preview',
            'agentWorkerRuntimeTraceExportRetentionPresetAdviceAuditPreview',
            'loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceAuditPreview',
            '/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview',
            'runtime_trace_export_retention_preset_advice_audit_preview',
            'would_record',
            'writes_enabled',
            'history_writes_enabled',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('audit-preview', preview['status'], preview['decision'], preview['dry_run'], preview['will_apply'], preview['writes_enabled'])
        print('would-record', record['record_type'], record['status'], record['recommended_preset'], record['recommended_action'], record['severity'])
        print('reason-codes', record['reason_codes'])
        print('impact-summary', record['recommended_impact_summary'])
        print('history', preview['history'])
        print('advice-record-match', preview['advice']['recommended_preset'] == record['recommended_preset'], preview['advice']['recommended_impact']['total_candidate_size_bytes'] == record['recommended_impact_summary']['total_candidate_size_bytes'])
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
