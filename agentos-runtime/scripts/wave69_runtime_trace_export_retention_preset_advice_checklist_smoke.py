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
HISTORY = ROOT / 'logs' / 'agent-worker' / 'retention-preset-advice-history.json'
LEDGERS = [
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
    HISTORY,
]
EXPECTED_CONSERVATIVE = {'max_active': 25, 'max_archived': 100, 'older_than_days': 90}
EXPECTED_IDS = [
    'review_recommended_impact_detail',
    'preview_recommended_retention_policy',
    'verify_safety_gates',
    'confirm_retention_apply_manually',
]
EXPECTED_GATES = [
    'dry_run_only',
    'retention_apply_requires_confirm_retention_true',
    'no_history_writes',
    'no_operational_ledger_mutation',
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
    baseline = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist')
    assert baseline['status'] == 'ok', baseline
    assert baseline['decision'] == 'runtime_trace_export_retention_preset_advice_checklist', baseline
    assert baseline['writes_enabled'] is False, baseline

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    for idx in range(30):
        temp_paths.append(EXPORT_DIR / f'wave69_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(110):
        temp_paths.append(ARCHIVE_DIR / f'wave69_archive_{stamp}_{idx:03d}_trace_202606170808{idx:03d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)

    try:
        future_base = int(time.time()) + 2800
        for idx in range(30):
            write_artifact(EXPORT_DIR / f'wave69_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(110):
            write_artifact(ARCHIVE_DIR / f'wave69_archive_{stamp}_{idx:03d}_trace_202606170808{idx:03d}.md', 20 + idx, future_base + 100 + idx)

        checklist_payload = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist')
        assert checklist_payload['status'] == 'ok', checklist_payload
        assert checklist_payload['decision'] == 'runtime_trace_export_retention_preset_advice_checklist', checklist_payload
        assert checklist_payload['dry_run'] is True and checklist_payload['will_apply'] is False, checklist_payload
        assert checklist_payload['writes_enabled'] is False, checklist_payload
        assert checklist_payload['advice']['recommended_preset'] == 'conservative', checklist_payload
        checklist = checklist_payload['checklist']
        assert checklist['recommended_preset'] == 'conservative', checklist
        assert checklist['recommended_policy'] == EXPECTED_CONSERVATIVE, checklist
        assert checklist['recommended_action'] == 'review_retention_preview', checklist
        assert checklist['severity'] == 'action_recommended', checklist
        assert checklist['apply_allowed_by_checklist'] is False, checklist
        assert checklist['requires_explicit_confirmation'] is True, checklist
        assert checklist['confirmation_field'] == 'confirm_retention', checklist
        assert checklist['confirmation_value'] is True, checklist
        ids = [item['id'] for item in checklist['items']]
        assert ids == EXPECTED_IDS, checklist
        assert checklist['items'][0]['endpoint'] == '/api/agent-worker/runtime-trace-export-retention/preset-impact/conservative', checklist
        assert checklist['items'][1]['endpoint'] == '/api/agent-worker/runtime-trace-export-retention/preview?max_active=25&max_archived=100&older_than_days=90', checklist
        assert checklist['items'][2]['gates'] == EXPECTED_GATES, checklist
        assert checklist['items'][3]['status'] == 'blocked_until_explicit_confirmation', checklist
        assert checklist['items'][3]['endpoint'] == '/api/agent-worker/runtime-trace-export-retention/apply', checklist
        assert checklist_payload['explanation']['decision'] == 'runtime_trace_export_retention_preset_advice_explanation', checklist_payload
        assert checklist_payload['safety'] == {
            'read_only': True,
            'retention_apply_called': False,
            'history_writes_enabled': False,
            'operational_ledgers_mutated': False,
        }, checklist_payload

        explain = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/explain')
        assert explain['explanation']['recommended']['preset'] == checklist['recommended_preset'], explain
        audit_preview = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview')
        assert audit_preview['would_record']['recommended_preset'] == checklist['recommended_preset'], audit_preview

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'checklist endpoint must not mutate operational/history ledgers'
        assert all(path.exists() for path in temp_paths), 'checklist endpoint must not move/delete artifacts'

        html = text('/')
        markers = [
            'Retention Preset Advice Checklist',
            'agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklist',
            'loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklist',
            '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist',
            'runtime_trace_export_retention_preset_advice_checklist',
            'review_recommended_impact_detail',
            'preview_recommended_retention_policy',
            'confirm_retention_apply_manually',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('checklist', checklist_payload['status'], checklist_payload['decision'], checklist_payload['dry_run'], checklist_payload['will_apply'], checklist_payload['writes_enabled'])
        print('recommended', checklist['recommended_preset'], checklist['recommended_action'], checklist['severity'], checklist['recommended_policy'])
        print('items', ids)
        print('gates', checklist['items'][2]['gates'])
        print('apply-step', checklist['items'][3]['status'], checklist['items'][3]['endpoint'], checklist['items'][3]['confirmation_field'], checklist['items'][3]['confirmation_value'])
        print('explain-checklist-match', explain['explanation']['recommended']['preset'] == checklist['recommended_preset'])
        print('audit-preview-match', audit_preview['would_record']['recommended_preset'] == checklist['recommended_preset'])
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
