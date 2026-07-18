import json
import subprocess
import sys
import time
from pathlib import Path
from urllib import request

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'agentosctl.py'
BASE = 'http://127.0.0.1:8765'
LEDGERS = [
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
    ROOT / 'logs' / 'agent-worker' / 'retention-preset-advice-history.json',
    ROOT / 'config' / 'agent-worker.json',
]
MARKERS = [
    'Production Readiness',
    'loadProductionReadinessExportPreview',
    '/api/production-readiness/export?max_chars=1600',
    'production_readiness_export_preview',
    'markdown_preview',
    'Export readiness preview',
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
    run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
    before = file_snapshot(LEDGERS)

    readiness = api('/api/production-readiness')
    assert readiness['decision'] == 'production_readiness', readiness
    assert readiness['status'] in {'ready_local', 'ready_with_optional_blockers'}, readiness
    assert readiness['readiness']['local_ready'] is True, readiness
    assert readiness['readiness']['required_checks_passed'] is True, readiness
    assert readiness['readiness']['worker_safe_state'] is True, readiness
    assert readiness['required_blockers'] == [], readiness

    preview = api('/api/production-readiness/export?max_chars=900')
    assert preview['status'] == 'ok', preview
    assert preview['decision'] == 'production_readiness_export_preview', preview
    assert preview['dry_run'] is True and preview['will_apply'] is False, preview
    assert preview['writes_enabled'] is False and preview['read_only'] is True, preview
    assert preview['artifact_path'] is None and preview['artifact_relpath'] is None, preview
    assert preview['readiness']['status'] == readiness['status'], preview
    body = preview['export_preview']['markdown_preview']
    assert preview['export_preview']['format'] == 'markdown', preview
    assert preview['export_preview']['title'] == 'AgentOS Production Readiness', preview
    assert preview['export_preview']['max_chars'] == 900, preview
    assert '# AgentOS Production Readiness' in body, body
    assert readiness['status'] in body, body
    assert 'required_blockers' in body and 'optional_blockers' in body, body
    assert 'api_key:' not in body.lower(), body
    assert preview['export_preview']['redactions'] == ['api_key', 'token', 'secret', 'password'], preview
    assert preview['safety']['read_only'] is True, preview
    assert preview['safety']['artifact_write_enabled'] is False, preview
    assert preview['safety']['history_writes_enabled'] is False, preview
    assert preview['safety']['retention_apply_called'] is False, preview

    full = api('/api/production-readiness/export?max_chars=0')
    assert full['status'] == 'ok', full
    assert full['export_preview']['max_chars'] == 0, full
    assert full['export_preview']['truncated'] is False, full
    assert '## Worker Safe-State' in full['export_preview']['markdown_preview'], full

    after = file_snapshot(LEDGERS)
    assert after == before, 'production readiness export preview must not mutate ledgers or worker config'

    html = text('/')
    assert all(marker in html for marker in MARKERS), MARKERS
    worker_status = run_cli('agent', 'worker', 'status', '--pretty')

    print('dashboard-ready', BASE, status.get('workspace'))
    print('readiness', readiness['status'], readiness['readiness'], readiness['required_blockers'], readiness['optional_blockers'])
    print('export-preview', preview['status'], preview['decision'], preview['dry_run'], preview['will_apply'], preview['writes_enabled'], preview['read_only'])
    print('preview-shape', preview['export_preview']['format'], preview['export_preview']['max_chars'], preview['export_preview']['content_length'], len(body), preview['export_preview']['truncated'])
    print('full-preview', full['export_preview']['max_chars'], full['export_preview']['truncated'], '## Worker Safe-State' in full['export_preview']['markdown_preview'])
    print('safety', preview['safety'])
    print('redactions', preview['export_preview']['redactions'])
    print('links', preview['links'])
    print('read-only-files', {Path(key).name: after[key] == before[key] for key in before})
    print('frontend-markers', True, ','.join(MARKERS))
    print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])


if __name__ == '__main__':
    main()
