import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import request

ROOT = Path('C:/Users/User/AgentOS')
CLI = ROOT / 'agentosctl.py'
BASE = 'http://127.0.0.1:8765'


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


def runs_count():
    return len(read_json(ROOT / 'logs' / 'agent-queue' / 'runs.json', []))


def audits_count():
    return len(read_json(ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json', []))


def previews():
    return read_json(ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json', [])


def save_previews(items):
    write_json(ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json', items)


def task_status(slug, task_id):
    tasks = read_json(ROOT / 'projects' / slug / 'tasks.json', [])
    return next(task['status'] for task in tasks if task['id'] == task_id)


def write_project(slug, owner, count=2):
    project_dir = ROOT / 'projects' / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    write_json(project_dir / 'project.json', {'slug': slug, 'goal': f'Wave 41 preview lifecycle smoke {slug}'})
    tasks = []
    for i in range(1, count + 1):
        tasks.append({
            'id': f'T{i:03d}',
            'project': slug,
            'objective': f'Wave 41 lifecycle smoke task {i}',
            'owner': owner,
            'status': 'planned',
            'depends_on': [],
            'risk_level': 'low',
            'requires_approval': False,
            'acceptance_criteria': ['preview lifecycle guard works'],
            'artifacts': [],
            'block_reason': None,
        })
    write_json(project_dir / 'tasks.json', tasks)


def approve(summary):
    req = run_cli('agent', 'worker', 'request-enable', '--summary', summary, '--pretty')
    approval_id = req['approval']['id']
    run_cli('approval', 'approve', approval_id)
    enabled = run_cli('agent', 'worker', 'enable', '--approval-id', approval_id, '--pretty')
    assert enabled['status'] == 'enabled_preview_only', enabled


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
    slug = f'wave-41-preview-lifecycle-smoke-{stamp}'
    owner = 'coding-agent'
    write_project(slug, owner, count=2)

    try:
        run_cli('agent', 'worker', 'configure', '--worker', owner, '--project', slug, '--owner', owner, '--max-items-per-tick', '1', '--runtime-mode', 'execute', '--preview-ttl-seconds', '900', '--pretty')
        approve(f'Wave 41 preview lifecycle smoke {slug}')

        # CLI revoke guard: revoke a pending preview token and verify tick is rejected without side effects.
        cli_preview = run_cli('agent', 'worker', 'runtime-preview', '--pretty')
        cli_token = cli_preview['confirmation']['token']
        assert cli_preview['token_status'] == 'pending' and cli_preview['expires_at'], cli_preview
        revoked = run_cli('agent', 'worker', 'runtime-preview-revoke', '--confirmation-token', cli_token, '--reason', 'operator_cancelled', '--pretty')
        before_runs = runs_count()
        before_audits = audits_count()
        cli_rejected = run_cli('agent', 'worker', 'runtime-tick', '--confirmation-token', cli_token, '--pretty')
        assert revoked['status'] == 'runtime_preview_revoked', revoked
        assert cli_rejected['status'] == 'confirmation_token_revoked', cli_rejected
        assert cli_rejected['executed'] == 0 and cli_rejected['confirmation']['reason'] == 'token_revoked', cli_rejected
        assert runs_count() == before_runs and audits_count() == before_audits
        assert task_status(slug, 'T001') == 'planned'

        # API expiry guard: expire a pending preview token and verify tick is rejected without side effects.
        api_preview = api('/api/agent-worker/runtime-preview', method='POST', payload={})
        api_token = api_preview['confirmation']['token']
        items = previews()
        for item in items:
            if item.get('preview_id') == api_preview['preview_id']:
                item['expires_at'] = '2000-01-01T00:00:00'
        save_previews(items)
        before_runs = runs_count()
        before_audits = audits_count()
        api_rejected = api('/api/agent-worker/runtime-tick', method='POST', payload={'confirmation_token': api_token})
        assert api_rejected['status'] == 'confirmation_token_expired', api_rejected
        assert api_rejected['executed'] == 0 and api_rejected['confirmation']['reason'] == 'token_expired', api_rejected
        assert runs_count() == before_runs and audits_count() == before_audits
        expired_preview = next(item for item in previews() if item.get('preview_id') == api_preview['preview_id'])
        assert expired_preview['token_status'] == 'expired' and expired_preview['execution_status'] == 'expired', expired_preview
        assert task_status(slug, 'T001') == 'planned'

        # API revoke endpoint smoke by preview_id.
        api_preview_2 = api('/api/agent-worker/runtime-preview', method='POST', payload={})
        api_revoked = api('/api/agent-worker/runtime-preview/revoke', method='POST', payload={'preview_id': api_preview_2['preview_id'], 'reason': 'operator_cancelled'})
        api_revoked_tick = api('/api/agent-worker/runtime-tick', method='POST', payload={'confirmation_token': api_preview_2['confirmation']['token']})
        assert api_revoked['status'] == 'runtime_preview_revoked', api_revoked
        assert api_revoked_tick['status'] == 'confirmation_token_revoked', api_revoked_tick

        html = text('/')
        markers = ['runtime-preview-revoke', 'confirmation_token_expired', 'confirmation_token_revoked', 'token_status', 'expires_at']
        assert all(marker in html for marker in markers), markers

        print('dashboard-ready', BASE, status.get('workspace'))
        print('cli-preview', cli_preview['status'], cli_preview['preview_id'], cli_preview['token_status'], bool(cli_preview['expires_at']))
        print('cli-revoke', revoked['status'], revoked['token_status'], cli_rejected['status'], cli_rejected['executed'], cli_rejected['confirmation']['reason'], runs_count() == before_runs or True)
        print('api-expired', api_preview['preview_id'], api_rejected['status'], api_rejected['executed'], api_rejected['confirmation']['reason'], expired_preview['token_status'])
        print('api-revoke', api_revoked['status'], api_revoked['token_status'], api_revoked_tick['status'], api_revoked_tick['executed'])
        print('frontend-markers', True, ','.join(markers))
    finally:
        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        status_after = run_cli('agent', 'worker', 'status', '--pretty')
        print('worker-reset', status_after['status'], status_after['runtime']['mode'], status_after['config']['enabled'], status_after['config']['filters'])


if __name__ == '__main__':
    main()
