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
EXPECTED_GATES = [
    'dry_run_only',
    'retention_apply_requires_confirm_retention_true',
    'no_history_writes',
    'no_operational_ledger_mutation',
]
EXPECTED_ITEMS = [
    'review_recommended_impact_detail',
    'preview_recommended_retention_policy',
    'verify_safety_gates',
    'confirm_retention_apply_manually',
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
    baseline = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence')
    assert baseline['status'] == 'ok', baseline
    assert baseline['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_evidence', baseline
    assert baseline['writes_enabled'] is False, baseline

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    for idx in range(30):
        temp_paths.append(EXPORT_DIR / f'wave71_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(110):
        temp_paths.append(ARCHIVE_DIR / f'wave71_archive_{stamp}_{idx:03d}_trace_202606171010{idx:03d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)

    try:
        future_base = int(time.time()) + 3200
        for idx in range(30):
            write_artifact(EXPORT_DIR / f'wave71_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(110):
            write_artifact(ARCHIVE_DIR / f'wave71_archive_{stamp}_{idx:03d}_trace_202606171010{idx:03d}.md', 20 + idx, future_base + 100 + idx)

        evidence_payload = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence')
        assert evidence_payload['status'] == 'ok', evidence_payload
        assert evidence_payload['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_evidence', evidence_payload
        assert evidence_payload['dry_run'] is True and evidence_payload['will_apply'] is False, evidence_payload
        assert evidence_payload['writes_enabled'] is False, evidence_payload
        assert evidence_payload['checklist']['decision'] == 'runtime_trace_export_retention_preset_advice_checklist', evidence_payload
        assert evidence_payload['progress']['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_progress', evidence_payload
        evidence = evidence_payload['evidence']
        assert evidence['bundle_type'] == 'retention_preset_advice_checklist_evidence', evidence
        assert evidence['recommended_preset'] == 'conservative', evidence
        assert evidence['recommended_action'] == 'review_retention_preview', evidence
        assert evidence['severity'] == 'action_recommended', evidence
        assert evidence['operator_state'] == 'pending_operator_review', evidence
        assert evidence['next_required_step'] == 'review_recommended_impact_detail', evidence
        assert evidence['apply_allowed'] is False and evidence['can_apply_now'] is False, evidence
        assert evidence['item_ids'] == EXPECTED_ITEMS, evidence
        assert [item['id'] for item in evidence['items']] == EXPECTED_ITEMS, evidence
        assert evidence['safety_gates'] == EXPECTED_GATES, evidence
        assert evidence['impact_summary']['archive_candidate_count'] >= 5, evidence
        assert evidence['impact_summary']['prune_candidate_count'] >= 10, evidence
        assert evidence['impact_summary']['total_candidate_count'] >= 15, evidence
        assert evidence['preview_counts']['active_total'] >= 30, evidence
        assert evidence['preview_counts']['archived_total'] >= 110, evidence
        assert evidence['linked_endpoints']['self'] == '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence', evidence
        assert evidence['linked_endpoints']['checklist'] == '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist', evidence
        assert evidence['linked_endpoints']['progress'] == '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress', evidence
        assert evidence['linked_endpoints']['recommended_impact_detail'].endswith('/preset-impact/conservative'), evidence
        assert evidence['linked_endpoints']['retention_apply'] == '/api/agent-worker/runtime-trace-export-retention/apply', evidence
        assert evidence_payload['safety'] == {
            'read_only': True,
            'retention_apply_called': False,
            'history_writes_enabled': False,
            'operational_ledgers_mutated': False,
        }, evidence_payload

        progress = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/progress')
        checklist = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist')
        assert progress['progress']['recommended_preset'] == evidence['recommended_preset'], progress
        assert checklist['checklist']['recommended_preset'] == evidence['recommended_preset'], checklist

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'evidence endpoint must not mutate operational/history ledgers'
        assert all(path.exists() for path in temp_paths), 'evidence endpoint must not move/delete artifacts'

        html = text('/')
        markers = [
            'Retention Preset Advice Checklist Evidence',
            'agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistEvidence',
            'loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistEvidence',
            '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence',
            'runtime_trace_export_retention_preset_advice_checklist_evidence',
            'impact_summary',
            'preview_counts',
            'linked_endpoints',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('evidence', evidence_payload['status'], evidence_payload['decision'], evidence_payload['dry_run'], evidence_payload['will_apply'], evidence_payload['writes_enabled'])
        print('recommended', evidence['recommended_preset'], evidence['recommended_action'], evidence['severity'], evidence['operator_state'], evidence['next_required_step'])
        print('impact-summary', evidence['impact_summary'])
        print('preview-counts', evidence['preview_counts'])
        print('safety-gates', evidence['safety_gates'])
        print('items', evidence['item_ids'])
        print('linked-endpoints', evidence['linked_endpoints'])
        print('checklist-evidence-match', checklist['checklist']['recommended_preset'] == evidence['recommended_preset'])
        print('progress-evidence-match', progress['progress']['recommended_preset'] == evidence['recommended_preset'])
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
