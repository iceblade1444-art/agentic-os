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
MARKERS = [
    'Retention Preset Advice Checklist Export Preview',
    'agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExportPreview',
    'loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExportPreview',
    '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview',
    'runtime_trace_export_retention_preset_advice_checklist_export_preview',
    'markdown_preview',
    'content_length',
    'artifact_write_enabled',
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
    baseline = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview?max_chars=700')
    assert baseline['status'] == 'ok', baseline
    assert baseline['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_export_preview', baseline
    assert baseline['writes_enabled'] is False, baseline
    assert baseline['artifact_path'] is None, baseline

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    for idx in range(30):
        temp_paths.append(EXPORT_DIR / f'wave72_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(110):
        temp_paths.append(ARCHIVE_DIR / f'wave72_archive_{stamp}_{idx:03d}_trace_202606171010{idx:03d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)
    candidate_export_preview_files_before = sorted(str(path) for path in EXPORT_DIR.glob('*checklist*export*preview*.md')) if EXPORT_DIR.exists() else []

    try:
        future_base = int(time.time()) + 3600
        for idx in range(30):
            write_artifact(EXPORT_DIR / f'wave72_active_{stamp}_{idx:02d}_trace.md', 10 + idx, future_base + idx)
        for idx in range(110):
            write_artifact(ARCHIVE_DIR / f'wave72_archive_{stamp}_{idx:03d}_trace_202606171010{idx:03d}.md', 20 + idx, future_base + 100 + idx)

        payload = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview?max_chars=900')
        assert payload['status'] == 'ok', payload
        assert payload['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_export_preview', payload
        assert payload['dry_run'] is True and payload['will_apply'] is False, payload
        assert payload['writes_enabled'] is False, payload
        assert payload['artifact_path'] is None and payload['artifact_relpath'] is None, payload
        assert payload['evidence']['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_evidence', payload
        assert payload['safety'] == {
            'read_only': True,
            'artifact_write_enabled': False,
            'history_writes_enabled': False,
            'retention_apply_called': False,
            'operational_ledgers_mutated': False,
        }, payload
        summary = payload['evidence_summary']
        preview = payload['export_preview']
        assert summary['recommended_preset'] == 'conservative', summary
        assert summary['recommended_action'] == 'review_retention_preview', summary
        assert summary['severity'] == 'action_recommended', summary
        assert summary['operator_state'] == 'pending_operator_review', summary
        assert summary['next_required_step'] == 'review_recommended_impact_detail', summary
        assert summary['archive_candidate_count'] >= 5, summary
        assert summary['prune_candidate_count'] >= 10, summary
        assert summary['total_candidate_count'] >= 15, summary
        assert summary['active_total'] >= 30, summary
        assert summary['archived_total'] >= 110, summary
        assert preview['format'] == 'markdown', preview
        assert preview['title'] == 'Retention Preset Advice Checklist Evidence', preview
        assert preview['max_chars'] == 900, preview
        assert len(preview['markdown_preview']) <= 900, preview
        assert preview['content_length'] >= len(preview['markdown_preview']), preview
        assert preview['line_count'] >= 20, preview
        assert preview['truncated'] is True, preview
        assert '# Retention Preset Advice Checklist Evidence' in preview['markdown_preview'], preview
        assert 'Decision: runtime_trace_export_retention_preset_advice_checklist_export_preview' in preview['markdown_preview'], preview
        assert 'Recommended preset: conservative' in preview['markdown_preview'], preview
        assert 'Recommended action: review_retention_preview' in preview['markdown_preview'], preview
        assert 'Next required step: review_recommended_impact_detail' in preview['markdown_preview'], preview
        assert '## Safety Gates' in preview['markdown_preview'], preview
        assert 'dry_run_only' in preview['markdown_preview'], preview
        assert '## Linked Endpoints' in preview['markdown_preview'], preview
        assert '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence' in preview['markdown_preview'], preview
        assert 'confirmation_token' not in preview['markdown_preview'].lower(), preview
        assert payload['links']['self'] == '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview', payload
        assert payload['links']['evidence'] == '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence', payload

        evidence_payload = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/evidence')
        assert evidence_payload['evidence']['recommended_preset'] == summary['recommended_preset'], evidence_payload

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'export preview endpoint must not mutate operational/history ledgers'
        assert all(path.exists() for path in temp_paths), 'export preview endpoint must not move/delete artifacts'
        candidate_export_preview_files_after = sorted(str(path) for path in EXPORT_DIR.glob('*checklist*export*preview*.md')) if EXPORT_DIR.exists() else []
        assert candidate_export_preview_files_after == candidate_export_preview_files_before, 'export preview must not write artifacts'

        html = text('/')
        assert all(marker in html for marker in MARKERS), MARKERS

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('export-preview', payload['status'], payload['decision'], payload['dry_run'], payload['will_apply'], payload['writes_enabled'], payload['artifact_path'])
        print('summary', summary)
        print('markdown-preview', preview['format'], preview['max_chars'], preview['content_length'], preview['line_count'], preview['truncated'])
        print('markdown-markers', '# Retention Preset Advice Checklist Evidence' in preview['markdown_preview'], '## Safety Gates' in preview['markdown_preview'], '## Linked Endpoints' in preview['markdown_preview'])
        print('redactions', preview['redactions'])
        print('evidence-export-match', evidence_payload['evidence']['recommended_preset'] == summary['recommended_preset'])
        print('read-only', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('artifacts-preserved', all(path.exists() for path in temp_paths), candidate_export_preview_files_after == candidate_export_preview_files_before)
        print('frontend-markers', True, ','.join(MARKERS))
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
