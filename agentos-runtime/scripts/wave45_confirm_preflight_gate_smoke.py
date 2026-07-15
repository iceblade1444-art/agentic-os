import json
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import request

ROOT = Path('C:/Users/User/AgentOS')
CLI = ROOT / 'agentosctl.py'
BASE = 'http://127.0.0.1:8765'

STATE_FILES = [
    ROOT / 'config' / 'agent-worker.json',
    ROOT / 'approvals' / 'approvals.json',
    ROOT / 'agents' / 'queue.json',
    ROOT / 'logs' / 'events.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
]


def run_cli(*args):
    proc = subprocess.run([sys.executable, str(CLI), '--workspace', str(ROOT), *args], text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"CLI failed {' '.join(args)}\nSTDOUT={proc.stdout}\nSTDERR={proc.stderr}")
    return json.loads(proc.stdout)


def api(path, method='GET', payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = request.Request(BASE + path, data=data, headers=headers, method=method)
    with request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def text(path):
    with request.urlopen(BASE + path, timeout=10) as resp:
        return resp.read().decode('utf-8')


def read_json(path, default):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def snapshot_state():
    return {str(path): (path.read_text(encoding='utf-8') if path.exists() else None) for path in STATE_FILES}


def restore_state(snapshot):
    for raw_path, content in snapshot.items():
        path = Path(raw_path)
        if content is None:
            if path.exists():
                path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')


def write_project(slug):
    project_dir = ROOT / 'projects' / slug
    if project_dir.exists():
        shutil.rmtree(project_dir)
    project_dir.mkdir(parents=True, exist_ok=True)
    write_json(project_dir / 'project.json', {'slug': slug, 'goal': f'Wave 45 smoke {slug}'})
    write_json(project_dir / 'tasks.json', [{
        'id': 'T001',
        'project': slug,
        'objective': 'Wave 45 runtime confirm preflight gate smoke task',
        'owner': 'dashboard-agent',
        'status': 'planned',
        'depends_on': [],
        'risk_level': 'low',
        'requires_approval': False,
        'acceptance_criteria': ['preflight gate verified'],
        'artifacts': [],
        'block_reason': None,
    }])
    return project_dir


def approve_worker():
    request_result = api('/api/agent-worker/request-enable', method='POST', payload={'summary': 'Wave 45 smoke approve runtime confirm preflight gate'})
    approval_id = request_result['approval']['id']
    api(f'/api/approvals/{approval_id}/approve', method='POST', payload={})
    enabled = api('/api/agent-worker/enable', method='POST', payload={'approval_id': approval_id})
    assert enabled['status'] == 'enabled_preview_only', enabled
    return approval_id


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

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    slug = f'wave45-smoke-{stamp}'
    project_dir = ROOT / 'projects' / slug
    snapshot = snapshot_state()
    try:
        write_project(slug)
        config = api('/api/agent-worker/config', method='POST', payload={'worker': 'dashboard-agent', 'max_items_per_tick': 1, 'runtime_mode': 'execute', 'filters': {'project': slug, 'owner': 'dashboard-agent'}})
        assert config['runtime']['mode'] == 'execute', config
        approve_worker()

        preview = api('/api/agent-worker/runtime-preview', method='POST', payload={})
        token = preview['confirmation']['token']
        executed = api('/api/agent-worker/runtime-tick', method='POST', payload={'confirm_execute': True, 'confirmation_token': token, 'preflight_gate': True})
        assert executed['status'] == 'runtime_execute_completed', executed
        assert executed['preflight_gate'] is True, executed
        assert executed['preflight']['status'] == 'confirmation_token_pending', executed
        assert executed['preflight']['can_execute'] is True, executed
        assert executed['preview_id'] == preview['preview_id'], executed

        stale_preview = api('/api/agent-worker/runtime-preview', method='POST', payload={})
        stale_token = stale_preview['confirmation']['token']
        previews_path = ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json'
        previews = read_json(previews_path, [])
        for item in previews:
            if item.get('preview_id') == stale_preview['preview_id']:
                item['expires_at'] = '2000-01-01T00:00:00'
        write_json(previews_path, previews)
        before_previews = read_json(previews_path, [])
        before_runs = read_json(ROOT / 'logs' / 'agent-queue' / 'runs.json', [])
        before_audits = read_json(ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json', [])
        blocked = api('/api/agent-worker/runtime-tick', method='POST', payload={'confirm_execute': True, 'confirmation_token': stale_token, 'preflight_gate': True})
        assert blocked['status'] == 'confirmation_preflight_blocked', blocked
        assert blocked['preflight']['status'] == 'confirmation_token_expired', blocked
        assert blocked['preflight']['confirmation']['reason'] == 'token_expired', blocked
        assert read_json(previews_path, []) == before_previews, 'blocked preflight must not mutate previews'
        assert read_json(ROOT / 'logs' / 'agent-queue' / 'runs.json', []) == before_runs, 'blocked preflight must not append runs'
        assert read_json(ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json', []) == before_audits, 'blocked preflight must not append audits'

        html = text('/')
        markers = ['preflight_gate', 'validateAgentWorkerRuntimePreviewToken(agentWorkerRuntimeConfirmationToken', 'preflight.can_execute', 'Runtime confirm preflight blocked', 'confirmation_preflight_blocked']
        assert all(marker in html for marker in markers), markers

        print('dashboard-ready', BASE, status.get('workspace'))
        print('api-gated-execute', executed['status'], executed['preflight']['status'], executed['preflight']['can_execute'], executed['preview_id'])
        print('api-gated-stale-block', blocked['status'], blocked['preflight']['status'], blocked['preflight']['confirmation']['reason'])
        print('blocked-no-mutation', read_json(previews_path, []) == before_previews, read_json(ROOT / 'logs' / 'agent-queue' / 'runs.json', []) == before_runs, read_json(ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json', []) == before_audits)
        print('frontend-markers', True, ','.join(markers))
    finally:
        restore_state(snapshot)
        if project_dir.exists():
            shutil.rmtree(project_dir)
        reset = run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        status_after = run_cli('agent', 'worker', 'status', '--pretty')
        print('worker-reset', status_after['status'], status_after['runtime']['mode'], status_after['config']['enabled'], status_after['config']['filters'])


if __name__ == '__main__':
    main()
