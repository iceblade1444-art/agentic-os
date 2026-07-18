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
CHECKLIST_EXPORT_DIR = ROOT / 'artifacts' / 'agent-worker' / 'runtime-trace-retention'
HISTORY = ROOT / 'logs' / 'agent-worker' / 'retention-preset-advice-history.json'
LEDGERS = [
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
    HISTORY,
]
MARKERS = [
    'Retention Preset Advice Checklist Exports',
    'agentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExports',
    'loadAgentWorkerRuntimeTraceExportRetentionPresetAdviceChecklistExports',
    '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=10',
    'runtime_trace_export_retention_preset_advice_checklist_export_index',
    'artifact_relpath',
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


def write_export(path, body, mtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding='utf-8')
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
    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    files = [
        CHECKLIST_EXPORT_DIR / f'retention_preset_advice_checklist_evidence_{stamp}_old74.md',
        CHECKLIST_EXPORT_DIR / f'retention_preset_advice_checklist_evidence_{stamp}_mid74.md',
        CHECKLIST_EXPORT_DIR / f'retention_preset_advice_checklist_evidence_{stamp}_new74.md',
        CHECKLIST_EXPORT_DIR / f'wave74_unrelated_{stamp}.md',
    ]
    originals = file_snapshot(files)
    ledger_before = file_snapshot(LEDGERS)

    try:
        future_base = int(time.time()) + 7200
        write_export(files[0], '# Retention Preset Advice Checklist Evidence\n\nold wave74 dossier\n', future_base + 1)
        write_export(files[1], '# Retention Preset Advice Checklist Evidence\n\nmid wave74 dossier\n', future_base + 2)
        write_export(files[2], '# Retention Preset Advice Checklist Evidence\n\nnew wave74 dossier\n', future_base + 3)
        write_export(files[3], '# Retention Preset Advice Checklist Evidence\n\nunrelated wave74 dossier\n', future_base + 4)

        limited = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=2')
        assert limited['status'] == 'ok', limited
        assert limited['decision'] == 'runtime_trace_export_retention_preset_advice_checklist_export_index', limited
        assert limited['dry_run'] is True and limited['will_apply'] is False, limited
        assert limited['writes_enabled'] is False and limited['artifact_write_enabled'] is False, limited
        assert limited['count'] == 2, limited
        assert limited['total'] >= 3, limited
        assert [item['filename'] for item in limited['exports'][:2]] == [files[2].name, files[1].name], limited
        assert all(item['title'] == 'Retention Preset Advice Checklist Evidence' for item in limited['exports']), limited
        assert all(item['artifact_relpath'].startswith('artifacts/agent-worker/runtime-trace-retention/') for item in limited['exports']), limited
        assert limited['exports'][0]['links']['export'] == '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export', limited
        assert limited['exports'][0]['links']['export_preview'] == '/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/export-preview', limited
        assert files[3].name not in [item['filename'] for item in limited['exports']], limited

        all_exports = api('/api/agent-worker/runtime-trace-export-retention/preset-advice/checklist/exports?limit=0')
        names = [item['filename'] for item in all_exports['exports']]
        assert files[2].name in names and files[1].name in names and files[0].name in names, all_exports
        assert files[3].name not in names, all_exports

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'checklist export index must not mutate operational/history ledgers'
        assert all(path.exists() for path in files), 'checklist export index must not mutate artifact files'

        html = text('/')
        assert all(marker in html for marker in MARKERS), MARKERS

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('index', limited['status'], limited['decision'], limited['dry_run'], limited['will_apply'], limited['writes_enabled'], limited['artifact_write_enabled'])
        print('limited', limited['count'], limited['total'], [item['filename'] for item in limited['exports']])
        print('all-contains-wave74', files[2].name in names, files[1].name in names, files[0].name in names, files[3].name not in names)
        print('entry', limited['exports'][0]['export_id'], limited['exports'][0]['title'], limited['exports'][0]['artifact_relpath'], limited['exports'][0]['size_bytes'])
        print('links', limited['links'])
        print('read-only-ledgers', {Path(key).name: ledger_after[key] == ledger_before[key] for key in ledger_before})
        print('artifacts-preserved', all(path.exists() for path in files))
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
