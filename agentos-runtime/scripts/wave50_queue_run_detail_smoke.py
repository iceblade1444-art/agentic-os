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
RUNS_PATH = ROOT / 'logs' / 'agent-queue' / 'runs.json'
AUDITS_PATH = ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json'


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


def read_json(path):
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, items):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding='utf-8')


def queue_run(run_id):
    return {
        'run_id': run_id,
        'queue_id': f'queue_{run_id}',
        'project': 'wave50-smoke',
        'task_id': 'T001',
        'objective': 'Wave 50 queue run detail smoke',
        'owner': 'dashboard-agent',
        'worker': 'dashboard-agent',
        'executor': 'dashboard-agent',
        'trigger': 'runtime_confirm_execute',
        'status': 'done',
        'started_at': datetime.now().replace(microsecond=0).isoformat(),
        'completed_at': datetime.now().replace(microsecond=0).isoformat(),
        'artifact_path': f'C:/tmp/{run_id}.md',
        'log_path': f'C:/tmp/{run_id}.log',
        'result_summary': f'wave50 smoke summary {run_id}',
        'filters': {'project': 'wave50-smoke'},
        'execution_context': {
            'runtime_preview_id': f'preview_{run_id}',
            'one_shot_run_id': f'runtime_once_{run_id}',
            'confirmation_token': f'token_{run_id}',
        },
        'runtime_preview_id': f'preview_{run_id}',
        'one_shot_run_id': f'runtime_once_{run_id}',
        'confirmation_token': f'token_{run_id}',
    }


def runtime_audit(audit_id, run_id):
    return {
        'id': audit_id,
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'status': 'runtime_execute_completed',
        'trigger': 'wave50_smoke',
        'worker': 'dashboard-agent',
        'approval_id': 'approval_wave50_smoke',
        'preview_id': f'preview_{run_id}',
        'one_shot_run_id': f'runtime_once_{run_id}',
        'confirmation_token': f'token_{run_id}',
        'planned': 1,
        'executed': 1,
        'max_items': 1,
        'queue_ids': [f'queue_{run_id}'],
        'queue_run_ids': [run_id],
        'items': [{'queue_id': f'queue_{run_id}', 'run_id': run_id}],
        'execution_policy': {'manual_only': True, 'confirmation_required': True},
    }


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

    original_runs_exists = RUNS_PATH.exists()
    original_audits_exists = AUDITS_PATH.exists()
    original_runs_text = RUNS_PATH.read_text(encoding='utf-8') if original_runs_exists else None
    original_audits_text = AUDITS_PATH.read_text(encoding='utf-8') if original_audits_exists else None
    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    run_id = f'wave50_smoke_{stamp}_run'
    audit_id = f'wave50_smoke_{stamp}_audit'
    try:
        write_json(RUNS_PATH, read_json(RUNS_PATH) + [queue_run(run_id)])
        write_json(AUDITS_PATH, read_json(AUDITS_PATH) + [runtime_audit(audit_id, run_id)])
        before_runs = read_json(RUNS_PATH)
        before_audits = read_json(AUDITS_PATH)

        detail = api(f'/api/agent-queue/runs/{run_id}')
        assert detail['status'] == 'agent_queue_run_found', detail
        assert detail['decision'] == 'agent_queue_run_detail', detail
        assert detail['run_id'] == run_id, detail
        assert detail['links']['runtime_preview_detail'] == f'/api/agent-worker/runtime-previews/preview_{run_id}', detail
        assert detail['links']['runtime_audit_detail'] == f'/api/agent-worker/runtime-audits/{audit_id}', detail
        assert detail['links']['artifact_path'] == f'C:/tmp/{run_id}.md', detail
        assert detail['links']['log_path'] == f'C:/tmp/{run_id}.log', detail

        audit_detail = api(f'/api/agent-worker/runtime-audits/{audit_id}')
        assert audit_detail['status'] == 'runtime_audit_found', audit_detail
        assert audit_detail['links']['queue_run_details'] == [f'/api/agent-queue/runs/{run_id}'], audit_detail

        missing = api('/api/agent-queue/runs/wave50_missing_run')
        assert missing['status'] == 'agent_queue_run_not_found', missing
        assert missing['run'] is None, missing
        assert missing['links'] == {}, missing

        listed = api('/api/agent-queue/runs?limit=0')
        assert any(item['run_id'] == run_id for item in listed['runs']), listed
        assert read_json(RUNS_PATH) == before_runs, 'queue run detail/listing must be read-only for runs'
        assert read_json(AUDITS_PATH) == before_audits, 'queue run detail/listing must be read-only for audits'

        html = text('/')
        markers = ['showAgentQueueRunDetail', '/api/agent-queue/runs/${encodeURIComponent(runId)}', 'Queue run detail', "showAgentQueueRunDetail(${JSON.stringify(run.run_id || '')})"]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('queue-run-detail', detail['status'], detail['run_id'], detail['links']['runtime_preview_detail'], detail['links']['runtime_audit_detail'])
        print('audit-cross-link', audit_detail['status'], audit_detail['audit_id'], audit_detail['links']['queue_run_details'][0])
        print('not-found', missing['status'], missing['run'] is None, missing['links'])
        print('listing-still-works', listed['count'], any(item['run_id'] == run_id for item in listed['runs']))
        print('read-only', read_json(RUNS_PATH) == before_runs, read_json(AUDITS_PATH) == before_audits)
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if original_runs_exists:
            RUNS_PATH.write_text(original_runs_text, encoding='utf-8')
        elif RUNS_PATH.exists():
            RUNS_PATH.unlink()
        if original_audits_exists:
            AUDITS_PATH.write_text(original_audits_text, encoding='utf-8')
        elif AUDITS_PATH.exists():
            AUDITS_PATH.unlink()


if __name__ == '__main__':
    main()
