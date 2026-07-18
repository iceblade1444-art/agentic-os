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
PREVIEWS_PATH = ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json'
ATTEMPTS_PATH = ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json'
AUDITS_PATH = ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json'
RUNS_PATH = ROOT / 'logs' / 'agent-queue' / 'runs.json'


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


def preview(preview_id, one_shot_run_id, audit_id, run_ids):
    return {
        'id': preview_id,
        'preview_id': preview_id,
        'one_shot_run_id': one_shot_run_id,
        'status': 'runtime_execute_preview',
        'execution_status': 'runtime_execute_completed',
        'token_status': 'consumed',
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'worker': 'dashboard-agent',
        'approval_id': 'approval_wave51_smoke',
        'planned': len(run_ids),
        'executed': len(run_ids),
        'queue_ids': [f'queue_{run_id}' for run_id in run_ids],
        'queue_run_ids': run_ids,
        'runtime_audit_id': audit_id,
        'confirmation': {'token': f'token_{one_shot_run_id}', 'accepted': True},
    }


def attempt(attempt_id, preview_id, one_shot_run_id, audit_id, run_ids):
    return {
        'id': attempt_id,
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'status': 'runtime_confirm_attempt_recorded',
        'final_status': 'runtime_execute_completed',
        'runtime_called': True,
        'preflight_status': 'confirmation_token_pending',
        'preflight_can_execute': True,
        'preflight_reason': 'wave51 smoke token pending',
        'preview_id': preview_id,
        'one_shot_run_id': one_shot_run_id,
        'confirmation_token': f'token_{one_shot_run_id}',
        'executed': len(run_ids),
        'runtime_audit_id': audit_id,
        'queue_run_ids': run_ids,
    }


def audit(audit_id, preview_id, one_shot_run_id, run_ids):
    return {
        'id': audit_id,
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'status': 'runtime_execute_completed',
        'trigger': 'wave51_smoke',
        'worker': 'dashboard-agent',
        'approval_id': 'approval_wave51_smoke',
        'preview_id': preview_id,
        'one_shot_run_id': one_shot_run_id,
        'confirmation_token': f'token_{one_shot_run_id}',
        'planned': len(run_ids),
        'executed': len(run_ids),
        'max_items': len(run_ids),
        'queue_ids': [f'queue_{run_id}' for run_id in run_ids],
        'queue_run_ids': run_ids,
        'items': [{'queue_id': f'queue_{run_id}', 'run_id': run_id} for run_id in run_ids],
        'execution_policy': {'manual_only': True, 'confirmation_required': True},
    }


def queue_run(run_id, preview_id, one_shot_run_id):
    return {
        'run_id': run_id,
        'queue_id': f'queue_{run_id}',
        'project': 'wave51-smoke',
        'task_id': run_id[-4:],
        'objective': 'Wave 51 runtime trace graph smoke',
        'owner': 'dashboard-agent',
        'worker': 'dashboard-agent',
        'executor': 'dashboard-agent',
        'trigger': 'runtime_confirm_execute',
        'status': 'done',
        'started_at': datetime.now().replace(microsecond=0).isoformat(),
        'completed_at': datetime.now().replace(microsecond=0).isoformat(),
        'runtime_preview_id': preview_id,
        'one_shot_run_id': one_shot_run_id,
        'confirmation_token': f'token_{one_shot_run_id}',
        'execution_context': {'runtime_preview_id': preview_id, 'one_shot_run_id': one_shot_run_id, 'confirmation_token': f'token_{one_shot_run_id}'},
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

    originals = {}
    for path in [PREVIEWS_PATH, ATTEMPTS_PATH, AUDITS_PATH, RUNS_PATH]:
        originals[path] = (path.exists(), path.read_text(encoding='utf-8') if path.exists() else None)

    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    one_shot_run_id = f'wave51_smoke_{stamp}_trace'
    preview_id = f'wave51_smoke_{stamp}_preview'
    audit_id = f'wave51_smoke_{stamp}_audit'
    attempt_id = f'wave51_smoke_{stamp}_attempt'
    run_ids = [f'wave51_smoke_{stamp}_run_a', f'wave51_smoke_{stamp}_run_b']
    try:
        write_json(PREVIEWS_PATH, read_json(PREVIEWS_PATH) + [preview(preview_id, one_shot_run_id, audit_id, run_ids)])
        write_json(ATTEMPTS_PATH, read_json(ATTEMPTS_PATH) + [attempt(attempt_id, preview_id, one_shot_run_id, audit_id, run_ids)])
        write_json(AUDITS_PATH, read_json(AUDITS_PATH) + [audit(audit_id, preview_id, one_shot_run_id, run_ids)])
        write_json(RUNS_PATH, read_json(RUNS_PATH) + [queue_run(run_ids[0], preview_id, one_shot_run_id), queue_run(run_ids[1], preview_id, one_shot_run_id)])
        before = {path: read_json(path) for path in [PREVIEWS_PATH, ATTEMPTS_PATH, AUDITS_PATH, RUNS_PATH]}

        trace = api(f'/api/agent-worker/runtime-traces/{one_shot_run_id}')
        assert trace['status'] == 'runtime_trace_found', trace
        assert trace['decision'] == 'runtime_trace_graph', trace
        assert trace['one_shot_run_id'] == one_shot_run_id, trace
        assert trace['preview_id'] == preview_id, trace
        assert trace['runtime_audit_id'] == audit_id, trace
        assert trace['confirm_attempt_ids'] == [attempt_id], trace
        assert trace['queue_run_ids'] == run_ids, trace
        assert trace['counts'] == {'previews': 1, 'confirmation_attempts': 1, 'runtime_audits': 1, 'queue_runs': 2}, trace
        assert trace['links']['preview_detail'] == f'/api/agent-worker/runtime-previews/{preview_id}', trace
        assert trace['links']['confirm_attempt_details'] == [f'/api/agent-worker/runtime-confirm-attempts/{attempt_id}'], trace
        assert trace['links']['runtime_audit_detail'] == f'/api/agent-worker/runtime-audits/{audit_id}', trace
        assert trace['links']['queue_run_details'] == [f'/api/agent-queue/runs/{run_ids[0]}', f'/api/agent-queue/runs/{run_ids[1]}'], trace

        preview_detail = api(f'/api/agent-worker/runtime-previews/{preview_id}')
        attempt_detail = api(f'/api/agent-worker/runtime-confirm-attempts/{attempt_id}')
        audit_detail = api(f'/api/agent-worker/runtime-audits/{audit_id}')
        run_detail = api(f'/api/agent-queue/runs/{run_ids[0]}')
        assert preview_detail['status'] == 'runtime_preview_found', preview_detail
        assert attempt_detail['status'] == 'runtime_confirm_attempt_found', attempt_detail
        assert audit_detail['status'] == 'runtime_audit_found', audit_detail
        assert run_detail['status'] == 'agent_queue_run_found', run_detail

        missing = api('/api/agent-worker/runtime-traces/wave51_missing_trace')
        assert missing['status'] == 'runtime_trace_not_found', missing
        assert missing['trace'] == {'preview': None, 'confirmation_attempts': [], 'runtime_audit': None, 'queue_runs': []}, missing
        assert missing['links'] == {}, missing

        assert {path: read_json(path) for path in [PREVIEWS_PATH, ATTEMPTS_PATH, AUDITS_PATH, RUNS_PATH]} == before, 'trace graph and detail reads must be read-only'

        html = text('/')
        markers = [
            'showAgentWorkerRuntimeTrace',
            '/api/agent-worker/runtime-traces/${encodeURIComponent(oneShotRunId)}',
            'Runtime trace graph',
            "showAgentWorkerRuntimeTrace(${JSON.stringify(preview.one_shot_run_id || '')})",
            "showAgentWorkerRuntimeTrace(${JSON.stringify(attempt.one_shot_run_id || '')})",
            "showAgentWorkerRuntimeTrace(${JSON.stringify(audit.one_shot_run_id || '')})",
            "showAgentWorkerRuntimeTrace(${JSON.stringify(run.one_shot_run_id || (run.execution_context || {}).one_shot_run_id || '')})",
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('trace-graph', trace['status'], trace['one_shot_run_id'], trace['preview_id'], trace['runtime_audit_id'], trace['queue_run_ids'])
        print('trace-counts', trace['counts'])
        print('trace-links', trace['links']['preview_detail'], trace['links']['runtime_audit_detail'], trace['links']['queue_run_details'][0])
        print('details-still-work', preview_detail['status'], attempt_detail['status'], audit_detail['status'], run_detail['status'])
        print('not-found', missing['status'], missing['counts'], missing['links'])
        print('read-only', {path.name: read_json(path) == before[path] for path in before})
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        for path, (exists, content) in originals.items():
            if exists:
                path.write_text(content, encoding='utf-8')
            elif path.exists():
                path.unlink()


if __name__ == '__main__':
    main()
