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
EXPECTED_IDS = [
    'review_recommended_impact_detail',
    'preview_recommended_retention_policy',
    'verify_safety_gates',
    'confirm_retention_apply_manually',
]
EXPECTED_PROGRESS = [
    'pending_operator_review',
    'pending_operator_review',
    'informational',
    'blocked_behind_explicit_confirmation',
]
EXPECTED_COUNTS = {
    'informational': 1,
    'pending_operator_review': 2,
    'blocked_behind_explicit_confirmation': 1,
    'not_recommended': 0,
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
    baseline = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress')
    assert baseline['status'] == 'ok', baseline
    assert baseline['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_progress', baseline
    assert baseline['writes_enabled'] is False, baseline

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    for idx in range(30):
        temp_paths.append(EXPORT_DIR / f'wave70_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(110):
        temp_paths.append(ARCHIVE_DIR / f'wave70_archive_{stamp}_{idx:03d}_trace_202606170909{idx:03d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)

    try:
        future_base = int(time.time()) + 3000
        for idx in range(30):
            write_artifact(EXPORT_DIR / f'wave70_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(110):
            write_artifact(ARCHIVE_DIR / f'wave70_archive_{stamp}_{idx:03d}_trace_202606170909{idx:03d}.md', 20 + idx, future_base + 100 + idx)

        progress_payload = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress')
        assert progress_payload['status'] == 'ok', progress_payload
        assert progress_payload['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_progress', progress_payload
        assert progress_payload['dry_run'] is True and progress_payload['will_apply'] is False, progress_payload
        assert progress_payload['writes_enabled'] is False, progress_payload
        assert progress_payload['checklist']['decision'] == 'runtime_trace_export_retention_preset_advice_checklist', progress_payload
        progress = progress_payload['progress']
        assert progress['recommended_preset'] == 'conservative', progress
        assert progress['recommended_action'] == 'review_retention_preview', progress
        assert progress['severity'] == 'action_recommended', progress
        assert progress['operator_state'] == 'pending_operator_review', progress
        assert progress['next_required_step'] == 'review_recommended_impact_detail', progress
        assert progress['apply_allowed'] is False and progress['can_apply_now'] is False, progress
        assert progress['status_counts'] == EXPECTED_COUNTS, progress
        assert [item['id'] for item in progress['items']] == EXPECTED_IDS, progress
        assert [item['progress_status'] for item in progress['items']] == EXPECTED_PROGRESS, progress
        assert progress['items'][2]['operator_action'] == 'read_safety_gates', progress
        assert progress['items'][3]['operator_action'] == 'do_not_apply_until_review_complete_and_confirm_retention_true', progress
        assert progress['items'][3]['requires_explicit_confirmation'] is True, progress
        assert progress['items'][3]['confirmation_field'] == 'confirm_retention', progress
        assert progress['items'][3]['confirmation_value'] is True, progress
        assert progress_payload['safety'] == {
            'read_only': True,
            'retention_apply_called': False,
            'history_writes_enabled': False,
            'operational_ledgers_mutated': False,
        }, progress_payload

        checklist = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist')
        assert checklist['checklist']['recommended_preset'] == progress['recommended_preset'], checklist
        assert [item['id'] for item in checklist['checklist']['items']] == [item['id'] for item in progress['items']], checklist

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'progress endpoint must not mutate operational/history ledgers'
        assert all(path.exists() for path in temp_paths), 'progress endpoint must not move/delete artifacts'

        html = text('/')
        markers = [
            'Retention Preset Advice Checklist Progress',
            'agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistProgress',
            'loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistProgress',
            '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress',
            'runtime_trace_export_retention_preset_advice_checklist_progress',
            'pending_operator_review',
            'blocked_behind_explicit_confirmation',
            'informational',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('progress', progress_payload['status'], progress_payload['decision'], progress_payload['dry_run'], progress_payload['will_apply'], progress_payload['writes_enabled'])
        print('recommended', progress['recommended_preset'], progress['recommended_action'], progress['severity'], progress['operator_state'], progress['next_required_step'])
        print('status-counts', progress['status_counts'])
        print('items', [item['id'] for item in progress['items']])
        print('progress-statuses', [item['progress_status'] for item in progress['items']])
        print('apply-step', progress['items'][3]['progress_status'], progress['items'][3]['operator_action'], progress['items'][3]['confirmation_field'], progress['items'][3]['confirmation_value'])
        print('checklist-progress-match', checklist['checklist']['recommended_preset'] == progress['recommended_preset'])
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
