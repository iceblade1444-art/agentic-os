import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import request

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'agentosctl.py'
BASE = 'http://127.0.0.1:8765'


def run_cli(*args):
    proc = subprocess.run([sys.executable, str(CLI), '--workspace', str(ROOT), *args], text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"CLI failed {' '.join(args)}\nSTDOUT={proc.stdout}\nSTDERR={proc.stderr}")
    text = proc.stdout.strip()
    return json.loads(text) if text else {}


def api(path, method='GET', payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = request.Request(BASE + path, data=data, headers=headers, method=method)
    with request.urlopen(req, timeout=10) as resp:
        raw = resp.read().decode('utf-8')
        return json.loads(raw) if raw else {}


def get_text(path):
    with request.urlopen(BASE + path, timeout=10) as resp:
        return resp.read().decode('utf-8')


def write_project(slug, owner):
    project_dir = ROOT / 'projects' / slug
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / 'project.json').write_text(json.dumps({'slug': slug, 'goal': f'Wave 39 smoke {slug}'}, ensure_ascii=False, indent=2), encoding='utf-8')
    tasks = []
    for i in range(1, 3):
        tasks.append({
            'id': f'T{i:03d}',
            'project': slug,
            'objective': f'Wave 39 runtime ledger smoke task {i}',
            'owner': owner,
            'status': 'planned',
            'depends_on': [],
            'risk_level': 'low',
            'requires_approval': False,
            'acceptance_criteria': ['runtime ledger trace is linked'],
            'artifacts': [],
            'block_reason': None,
        })
    (project_dir / 'tasks.json').write_text(json.dumps(tasks, ensure_ascii=False, indent=2), encoding='utf-8')
    return project_dir


def approve_worker(summary):
    req = run_cli('agent', 'worker', 'request-enable', '--summary', summary, '--pretty')
    approval_id = req['approval']['id']
    run_cli('approval', 'approve', approval_id)
    enabled = run_cli('agent', 'worker', 'enable', '--approval-id', approval_id, '--pretty')
    if enabled.get('status') != 'enabled_preview_only':
        raise AssertionError(f'enable failed: {enabled}')
    return approval_id


def main():
    last_error = None
    for _ in range(30):
        try:
            status = api('/api/status')
            if status.get('workspace'):
                break
        except Exception as exc:
            last_error = exc
            time.sleep(0.5)
    else:
        raise RuntimeError(f'dashboard not ready: {last_error}')

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    slug = f'wave-39-runtime-ledger-smoke-{stamp}'
    owner = 'coding-agent'
    write_project(slug, owner)

    try:
        run_cli('agent', 'worker', 'configure', '--worker', owner, '--project', slug, '--owner', owner, '--max-items-per-tick', '1', '--runtime-mode', 'execute', '--pretty')
        approve_worker(f'Wave 39 runtime ledger smoke {slug}')

        blocked = run_cli('agent', 'worker', 'runtime-tick', '--pretty')
        assert blocked['status'] == 'execute_confirmation_required', blocked
        assert blocked['executed'] == 0 and blocked['confirmation']['accepted'] is False, blocked

        preview = run_cli('agent', 'worker', 'runtime-preview', '--pretty')
        token = preview['confirmation']['token']
        assert preview['status'] == 'runtime_execute_preview', preview
        assert preview['preview_id'].startswith('runtime_preview_'), preview
        assert preview['one_shot_run_id'].startswith('runtime_once_'), preview
        assert preview['queue_ids'] == [f'{slug}:T001'], preview

        listed = run_cli('agent', 'worker', 'runtime-previews', '--limit', '1', '--pretty')
        assert listed['previews'][0]['preview_id'] == preview['preview_id'], listed

        executed = run_cli('agent', 'worker', 'runtime-tick', '--confirmation-token', token, '--pretty')
        assert executed['status'] == 'runtime_execute_completed', executed
        assert executed['preview_id'] == preview['preview_id'], executed
        assert executed['one_shot_run_id'] == preview['one_shot_run_id'], executed
        assert executed['executed'] == 1, executed

        runs = run_cli('agent', 'queue', 'runs', '--limit', '1', '--pretty')
        run_record = runs['runs'][0]
        audits = run_cli('agent', 'worker', 'runtime-audits', '--limit', '1', '--pretty')
        audit = audits['audits'][0]
        previews_after = run_cli('agent', 'worker', 'runtime-previews', '--limit', '3', '--pretty')
        updated_preview = next(p for p in previews_after['previews'] if p['preview_id'] == preview['preview_id'])
        assert audit['preview_id'] == preview['preview_id'], audit
        assert audit['one_shot_run_id'] == preview['one_shot_run_id'], audit
        assert run_record['runtime_preview_id'] == preview['preview_id'], run_record
        assert run_record['one_shot_run_id'] == preview['one_shot_run_id'], run_record
        assert updated_preview['runtime_audit_id'] == audit['id'], updated_preview
        assert run_record['run_id'] in updated_preview['queue_run_ids'], updated_preview

        api_preview = api('/api/agent-worker/runtime-preview', method='POST', payload={})
        api_token = api_preview['confirmation']['token']
        assert api_preview['queue_ids'] == [f'{slug}:T002'], api_preview
        api_previews = api('/api/agent-worker/runtime-previews?limit=1')
        assert api_previews['previews'][0]['preview_id'] == api_preview['preview_id'], api_previews
        api_executed = api('/api/agent-worker/runtime-tick', method='POST', payload={'confirmation_token': api_token})
        assert api_executed['status'] == 'runtime_execute_completed', api_executed
        assert api_executed['preview_id'] == api_preview['preview_id'], api_executed
        assert api_executed['one_shot_run_id'] == api_preview['one_shot_run_id'], api_executed

        latest_runs = api('/api/agent-queue/runs?limit=1')
        latest_run = latest_runs['runs'][0]
        latest_audits = api('/api/agent-worker/runtime-audits?limit=1')
        latest_audit = latest_audits['audits'][0]
        assert latest_run['runtime_preview_id'] == api_preview['preview_id'], latest_run
        assert latest_run['one_shot_run_id'] == api_preview['one_shot_run_id'], latest_run
        assert latest_audit['preview_id'] == api_preview['preview_id'], latest_audit

        html = get_text('/')
        markers = ['Runtime Preview Ledger', 'loadAgentWorkerRuntimePreviews', 'agentWorkerRuntimePreviews', '/api/agent-worker/runtime-previews', 'one_shot_run_id', 'preview_id']
        frontend_ok = all(marker in html for marker in markers)
        assert frontend_ok, [marker for marker in markers if marker not in html]

        print('dashboard-ready', BASE, status.get('workspace'))
        print('cli-blocked', blocked['status'], blocked['runtime_mode'], blocked['executed'], blocked['confirmation']['reason'])
        print('cli-preview', preview['status'], preview['preview_id'], preview['one_shot_run_id'], preview['queue_ids'], bool(token))
        print('cli-execute', executed['status'], executed['executed'], executed['preview_id'] == preview['preview_id'], audit['id'], run_record['run_id'])
        print('cli-ledger-links', updated_preview['runtime_audit_id'] == audit['id'], run_record['run_id'] in updated_preview['queue_run_ids'])
        print('api-preview', api_preview['status'], api_preview['preview_id'], api_preview['one_shot_run_id'], api_preview['queue_ids'], bool(api_token))
        print('api-execute', api_executed['status'], api_executed['executed'], latest_audit['preview_id'] == api_preview['preview_id'], latest_run['run_id'])
        print('frontend-markers', frontend_ok, ','.join(markers))
    finally:
        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        status_after = run_cli('agent', 'worker', 'status', '--pretty')
        print('worker-reset', status_after['status'], status_after['runtime']['mode'], status_after['config']['enabled'], status_after['config']['filters'])


if __name__ == '__main__':
    main()
