import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import request
from urllib.parse import urlparse, parse_qs

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
EXPECTED_PRESETS = {
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


def write_artifact(path, content, mtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    os.utime(path, (mtime, mtime))


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

    before_presets = api('/api/agent-worker/runtime-trace-export-retention/presets')
    assert before_presets['status'] == 'ok', before_presets
    assert before_presets['decision'] == 'runtime_trace_export_retention_presets', before_presets
    assert before_presets['dry_run'] is True and before_presets['will_apply'] is False, before_presets
    assert before_presets['default_preset'] == 'standard', before_presets
    assert before_presets['preset_names'] == ['conservative', 'standard', 'aggressive'], before_presets
    assert {preset['name']: preset['policy'] for preset in before_presets['presets']} == EXPECTED_PRESETS, before_presets
    assert before_presets['history'] == {'status': 'not_recorded', 'records': [], 'writes_enabled': False, 'reason': 'retention_presets_are_read_only'}, before_presets

    before_by_name = {preset['name']: preset for preset in before_presets['presets']}
    before_preview_counts = {}
    for name, preset in before_by_name.items():
        parsed = urlparse(preset['preview_url'])
        assert parsed.path == '/api/agent-worker/runtime-trace-export-retention/preview', preset
        query = parse_qs(parsed.query)
        assert query == {
            'max_active': [str(preset['policy']['max_active'])],
            'max_archived': [str(preset['policy']['max_archived'])],
            'older_than_days': [str(preset['policy']['older_than_days'])],
        }, preset
        preview = api(preset['preview_url'])
        assert preview['policy'] == preset['policy'], preview
        assert preview['dry_run'] is True and preview['will_apply'] is False, preview
        before_preview_counts[name] = preview['counts']

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    temp_paths = []
    future_base = int(time.time()) + 1200
    for idx in range(12):
        temp_paths.append(EXPORT_DIR / f'wave63_active_{stamp}_{idx:02d}_trace.md')
    for idx in range(52):
        temp_paths.append(ARCHIVE_DIR / f'wave63_archive_{stamp}_{idx:02d}_trace_202606170101{idx:02d}.md')

    originals = file_snapshot(temp_paths)
    ledger_before = file_snapshot(LEDGERS)

    try:
        for idx in range(12):
            write_artifact(EXPORT_DIR / f'wave63_active_{stamp}_{idx:02d}_trace.md', f'wave63-active-{idx}', future_base + idx)
        for idx in range(52):
            write_artifact(ARCHIVE_DIR / f'wave63_archive_{stamp}_{idx:02d}_trace_202606170101{idx:02d}.md', f'wave63-archive-{idx}', future_base + 100 + idx)

        presets = api('/api/agent-worker/runtime-trace-export-retention/presets')
        by_name = {preset['name']: preset for preset in presets['presets']}
        assert by_name.keys() == before_by_name.keys(), presets
        after_preview_counts = {}
        for name, preset in by_name.items():
            preview = api(preset['preview_url'])
            assert preview['status'] == 'ok', preview
            assert preview['decision'] == 'runtime_trace_export_retention_preview', preview
            assert preview['policy'] == EXPECTED_PRESETS[name], preview
            after_preview_counts[name] = preview['counts']
            assert preview['counts']['archive_candidates'] >= before_preview_counts[name]['archive_candidates'], (name, preview, before_preview_counts[name])
            assert preview['counts']['prune_candidates'] >= before_preview_counts[name]['prune_candidates'], (name, preview, before_preview_counts[name])

        assert after_preview_counts['standard']['archive_candidates'] >= before_preview_counts['standard']['archive_candidates'] + 2, (before_preview_counts, after_preview_counts)
        assert after_preview_counts['standard']['prune_candidates'] >= before_preview_counts['standard']['prune_candidates'] + 2, (before_preview_counts, after_preview_counts)
        assert after_preview_counts['aggressive']['archive_candidates'] >= before_preview_counts['aggressive']['archive_candidates'] + 9, (before_preview_counts, after_preview_counts)
        assert after_preview_counts['aggressive']['prune_candidates'] >= before_preview_counts['aggressive']['prune_candidates'] + 42, (before_preview_counts, after_preview_counts)

        ledger_after = file_snapshot(LEDGERS)
        assert ledger_after == ledger_before, 'presets and preset previews must not mutate operational ledgers'
        assert all(path.exists() for path in temp_paths), 'presets and preset previews must not move/delete artifacts'

        html = text('/')
        markers = [
            'Retention Policy Presets',
            'agentWorkerRuntimeTraceExportRetentionPresets',
            'loadAgentWorkerRuntimeTraceExportRetentionPresets',
            'previewAgentWorkerRuntimeTraceExportRetentionPreset',
            '/api/agent-worker/runtime-trace-export-retention/presets',
            'runtime_trace_export_retention_presets',
            'conservative',
            'standard',
            'aggressive',
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('retention-presets', presets['status'], presets['decision'], presets['dry_run'], presets['will_apply'])
        print('preset-names', presets['preset_names'], 'default', presets['default_preset'])
        print('preset-policies', {name: by_name[name]['policy'] for name in by_name})
        print('history', presets['history'])
        print('preview-counts-before', before_preview_counts)
        print('preview-counts-after', after_preview_counts)
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
