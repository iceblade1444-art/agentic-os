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
    baseline = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/explain')
    assert baseline['status'] == 'ok', baseline
    assert baseline['decision'] == 'runtime_trace_export_retention_preset_advice_explanation', baseline
    assert baseline['writes_enabled'] is False, baseline

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    for idx in range(30):
        temp_paths.append(EXPORT_DIR / f'wave68_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(110):
        temp_paths.append(ARCHIVE_DIR / f'wave68_archive_{stamp}_{idx:03d}_trace_202606170707{idx:03d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)

    try:
        future_base = int(time.time()) + 2700
        for idx in range(30):
            write_artifact(EXPORT_DIR / f'wave68_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(110):
            write_artifact(ARCHIVE_DIR / f'wave68_archive_{stamp}_{idx:03d}_trace_202606170707{idx:03d}.md', 20 + idx, future_base + 100 + idx)

        explain = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/explain')
        assert explain['status'] == 'ok', explain
        assert explain['decision'] == 'runtime_trace_export_retention_preset_advice_explanation', explain
        assert explain['dry_run'] is True and explain['will_apply'] is False, explain
        assert explain['writes_enabled'] is False, explain
        assert explain['advice']['recommended_preset'] == 'conservative', explain
        explanation = explain['explanation']
        recommended = explanation['recommended']
        assert explanation['summary'].startswith('Recommended preset conservative'), explanation
        assert recommended['preset'] == 'conservative', recommended
        assert recommended['policy'] == EXPECTED_CONSERVATIVE, recommended
        assert recommended['action'] == 'review_retention_preview', recommended
        assert recommended['severity'] == 'action_recommended', recommended
        assert 'safest preset' in recommended['explanation'], recommended
        assert recommended['reason_codes'] == [
            'preset_impact_matrix_evaluated',
            'conservative_has_candidates_safest_action',
            'retention_apply_requires_confirm_retention_true',
        ], recommended
        assert recommended['impact_summary']['archive_candidate_count'] >= 5, recommended
        assert recommended['impact_summary']['prune_candidate_count'] >= 10, recommended
        assert explanation['operator_steps'] == [
            'review_conservative_impact_detail',
            'preview_conservative_retention',
            'apply_retention_requires_confirm_retention_true',
        ], explanation
        alternatives = {item['preset']: item for item in explanation['alternatives']}
        assert {'standard', 'aggressive'} <= set(alternatives), alternatives
        assert alternatives['standard']['guidance_level'] == 'more_aggressive_than_recommended', alternatives
        assert alternatives['aggressive']['guidance_level'] == 'higher_churn_available', alternatives
        safety_codes = [item['code'] for item in explanation['safety_gates']]
        assert safety_codes == [
            'dry_run_only',
            'retention_apply_requires_confirm_retention_true',
            'no_history_writes',
            'no_operational_ledger_mutation',
        ], safety_codes
        assert explain['safety'] == {
            'read_only': True,
            'retention_apply_called': False,
            'history_writes_enabled': False,
            'operational_ledgers_mutated': False,
        }, explain

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'explain endpoint must not mutate operational/history ledgers'
        assert all(path.exists() for path in temp_paths), 'explain endpoint must not move/delete artifacts'

        html = text('/')
        markers = [
            'Retention Preset Advice Explanation',
            'agentWorkerRuntimeTraceExportRetentionPresetAdviceExplanation',
            'loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceExplanation',
            '/api/agent-worker/runtime-trace-export-retention/preset-advice/explain',
            'runtime_trace_export_retention_preset_advice_explanation',
            'safety_gates',
            'alternatives',
            'operator_steps',
        ]
        assert all(marker in html for marker in markers), markers

        audit_preview = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/audit-preview')
        assert audit_preview['would_record']['recommended_preset'] == explain['advice']['recommended_preset'], audit_preview

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('explain', explain['status'], explain['decision'], explain['dry_run'], explain['will_apply'], explain['writes_enabled'])
        print('recommended', recommended['preset'], recommended['action'], recommended['severity'], recommended['policy'])
        print('reason-codes', recommended['reason_codes'])
        print('impact-summary', recommended['impact_summary'])
        print('alternatives', {name: item['guidance_level'] for name, item in alternatives.items()})
        print('safety-gates', safety_codes)
        print('operator-steps', explanation['operator_steps'])
        print('audit-preview-match', audit_preview['would_record']['recommended_preset'] == explain['advice']['recommended_preset'])
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
