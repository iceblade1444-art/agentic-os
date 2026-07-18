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
    'productionReadiness',
    'loadProductionReadiness',
    '/api/production-readiness',
    'ready_with_optional_blockers',
    'required_blockers',
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
    assert readiness['dry_run'] is True and readiness['will_apply'] is False, readiness
    assert readiness['writes_enabled'] is False and readiness['read_only'] is True, readiness
    assert readiness['status'] in {'ready_local', 'ready_with_optional_blockers'}, readiness
    assert readiness['readiness']['local_ready'] is True, readiness
    assert readiness['readiness']['required_checks_passed'] is True, readiness
    assert readiness['readiness']['worker_safe_state'] is True, readiness
    assert readiness['required_blockers'] == [], readiness
    assert readiness['release_check']['status'] == 'ready_local', readiness
    assert all(readiness['release_check']['checks'].values()), readiness
    assert readiness['latest_report']['exists'] is True, readiness
    assert readiness['latest_report']['relpath'].endswith('agentos-wave-75-report.md'), readiness
    assert readiness['worker']['status'] == 'disabled', readiness
    assert readiness['worker']['runtime']['mode'] == 'dry_run', readiness
    if 'gemini_live' in readiness['optional_blockers']:
        assert readiness['status'] == 'ready_with_optional_blockers', readiness
        assert 'configure_gemini_live_credentials' in readiness['operator_next_steps'], readiness
    else:
        assert readiness['status'] == 'ready_local', readiness

    after = file_snapshot(LEDGERS)
    assert after == before, 'production readiness endpoint must not mutate ledgers or worker config'

    html = text('/')
    assert all(marker in html for marker in MARKERS), MARKERS
    worker_status = run_cli('agent', 'worker', 'status', '--pretty')

    print('dashboard-ready', BASE, status.get('workspace'))
    print('production-readiness', readiness['status'], readiness['decision'], readiness['dry_run'], readiness['will_apply'], readiness['writes_enabled'], readiness['read_only'])
    print('readiness', readiness['readiness'])
    print('required-blockers', readiness['required_blockers'])
    print('optional-blockers', readiness['optional_blockers'])
    print('latest-report', readiness['latest_report']['relpath'], readiness['latest_report']['exists'])
    print('release-checks', readiness['release_check']['checks'])
    print('worker-safe', readiness['worker']['status'], readiness['worker']['runtime']['mode'], readiness['worker']['config']['enabled'])
    print('read-only-files', {Path(key).name: after[key] == before[key] for key in before})
    print('frontend-markers', True, ','.join(MARKERS))
    print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])


if __name__ == '__main__':
    main()
