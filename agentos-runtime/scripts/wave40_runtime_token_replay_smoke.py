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


def write_project(slug, owner):
    project_dir = ROOT / 'projects' / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / 'project.json').write_text(json.dumps({'slug': slug, 'goal': f'Wave 40 smoke {slug}'}, ensure_ascii=False, indent=2), encoding='utf-8')
    tasks = []
    for i in range(1, 3):
        tasks.append({
            'id': f'T{i:03d}',
            'project': slug,
            'objective': f'Wave 40 token replay smoke task {i}',
            'owner': owner,
            'status': 'planned',
            'depends_on': [],
            'risk_level': 'low',
            'requires_approval': False,
            'acceptance_criteria': ['confirmation token replay is rejected'],
            'artifacts': [],
            'block_reason': None,
        })
    (project_dir / 'tasks.json').write_text(json.dumps(tasks, ensure_ascii=False, indent=2), encoding='utf-8')


def approve(summary):
    req = run_cli('agent', 'worker', 'request-enable', '--summary', summary, '--pretty')
    approval_id = req['approval']['id']
    run_cli('approval', 'approve', approval_id)
    enabled = run_cli('agent', 'worker', 'enable', '--approval-id', approval_id, '--pretty')
    assert enabled['status'] == 'enabled_preview_only', enabled
    return approval_id


def task_status(slug, task_id):
    tasks = json.loads((ROOT / 'projects' / slug / 'tasks.json').read_text(encoding='utf-8'))
    return next(task['status'] for task in tasks if task['id'] == task_id)


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
    slug = f'wave-40-token-replay-smoke-{stamp}'
    owner = 'coding-agent'
    write_project(slug, owner)

    try:
        run_cli('agent', 'worker', 'configure', '--worker', owner, '--project', slug, '--owner', owner, '--max-items-per-tick', '1', '--runtime-mode', 'execute', '--pretty')
        approve(f'Wave 40 token replay smoke {slug}')

        cli_preview = run_cli('agent', 'worker', 'runtime-preview', '--pretty')
        cli_token = cli_preview['confirmation']['token']
        cli_executed = run_cli('agent', 'worker', 'runtime-tick', '--confirmation-token', cli_token, '--pretty')
        assert cli_executed['status'] == 'runtime_execute_completed', cli_executed
        runs_before = run_cli('agent', 'queue', 'runs', '--limit', '20', '--pretty')['count']
        audits_before = run_cli('agent', 'worker', 'runtime-audits', '--limit', '20', '--pretty')['count']
        cli_replay = run_cli('agent', 'worker', 'runtime-tick', '--confirmation-token', cli_token, '--pretty')
        runs_after = run_cli('agent', 'queue', 'runs', '--limit', '20', '--pretty')['count']
        audits_after = run_cli('agent', 'worker', 'runtime-audits', '--limit', '20', '--pretty')['count']
        assert cli_replay['status'] == 'confirmation_token_consumed', cli_replay
        assert cli_replay['executed'] == 0, cli_replay
        assert cli_replay['preview_id'] == cli_preview['preview_id'], cli_replay
        assert cli_replay['confirmation']['reason'] == 'token_consumed', cli_replay
        assert runs_after == runs_before and audits_after == audits_before, (runs_before, runs_after, audits_before, audits_after)
        assert task_status(slug, 'T002') == 'planned'

        api_preview = api('/api/agent-worker/runtime-preview', method='POST', payload={})
        api_token = api_preview['confirmation']['token']
        api_executed = api('/api/agent-worker/runtime-tick', method='POST', payload={'confirmation_token': api_token})
        assert api_executed['status'] == 'runtime_execute_completed', api_executed
        api_runs_before = api('/api/agent-queue/runs?limit=20')['count']
        api_audits_before = api('/api/agent-worker/runtime-audits?limit=20')['count']
        api_replay = api('/api/agent-worker/runtime-tick', method='POST', payload={'confirmation_token': api_token})
        api_runs_after = api('/api/agent-queue/runs?limit=20')['count']
        api_audits_after = api('/api/agent-worker/runtime-audits?limit=20')['count']
        assert api_replay['status'] == 'confirmation_token_consumed', api_replay
        assert api_replay['executed'] == 0, api_replay
        assert api_replay['preview_id'] == api_preview['preview_id'], api_replay
        assert api_replay['confirmation']['reason'] == 'token_consumed', api_replay
        assert api_runs_after == api_runs_before and api_audits_after == api_audits_before

        html = text('/')
        markers = ['confirmation_token_consumed', 'token_consumed', 'one-shot confirmation token']
        assert all(marker in html for marker in markers), markers

        print('dashboard-ready', BASE, status.get('workspace'))
        print('cli-execute', cli_executed['status'], cli_executed['executed'], cli_preview['preview_id'], cli_preview['one_shot_run_id'])
        print('cli-replay-blocked', cli_replay['status'], cli_replay['executed'], cli_replay['confirmation']['reason'], runs_before == runs_after, audits_before == audits_after, task_status(slug, 'T002'))
        print('api-execute', api_executed['status'], api_executed['executed'], api_preview['preview_id'], api_preview['one_shot_run_id'])
        print('api-replay-blocked', api_replay['status'], api_replay['executed'], api_replay['confirmation']['reason'], api_runs_before == api_runs_after, api_audits_before == api_audits_after)
        print('frontend-markers', True, ','.join(markers))
    finally:
        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        status_after = run_cli('agent', 'worker', 'status', '--pretty')
        print('worker-reset', status_after['status'], status_after['runtime']['mode'], status_after['config']['enabled'], status_after['config']['filters'])


if __name__ == '__main__':
    main()
