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
AUDITS_PATH = ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json'
ATTEMPTS_PATH = ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json'


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


def audit(audit_id):
    return {
        'id': audit_id,
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'status': 'runtime_execute_completed',
        'trigger': 'wave49_smoke',
        'worker': 'dashboard-agent',
        'approval_id': 'approval_wave49_smoke',
        'preview_id': f'preview_{audit_id}',
        'one_shot_run_id': f'runtime_once_{audit_id}',
        'confirmation_token': f'token_{audit_id}',
        'planned': 1,
        'executed': 1,
        'max_items': 1,
        'queue_ids': [f'queue_{audit_id}'],
        'queue_run_ids': [f'run_{audit_id}'],
        'items': [{'queue_id': f'queue_{audit_id}', 'run_id': f'run_{audit_id}'}],
        'execution_policy': {'manual_only': True, 'confirmation_required': True},
    }


def attempt(attempt_id, audit_id):
    return {
        'id': attempt_id,
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'status': 'runtime_confirm_attempt_recorded',
        'final_status': 'runtime_execute_completed',
        'decision': 'runtime_execute_completed',
        'runtime_called': True,
        'preflight_status': 'confirmation_token_pending',
        'preflight_can_execute': True,
        'preflight_reason': 'wave49 smoke token pending',
        'preview_id': f'preview_{audit_id}',
        'one_shot_run_id': f'runtime_once_{audit_id}',
        'confirmation_token': f'token_{audit_id}',
        'token_status': 'consumed',
        'executed': 1,
        'runtime_audit_id': audit_id,
        'queue_run_ids': [f'run_{audit_id}'],
        'preflight': {'status': 'confirmation_token_pending', 'can_execute': True},
        'result_summary': {'status': 'runtime_execute_completed', 'executed': 1, 'runtime_audit_id': audit_id},
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

    original_audits_exists = AUDITS_PATH.exists()
    original_attempts_exists = ATTEMPTS_PATH.exists()
    original_audits_text = AUDITS_PATH.read_text(encoding='utf-8') if original_audits_exists else None
    original_attempts_text = ATTEMPTS_PATH.read_text(encoding='utf-8') if original_attempts_exists else None
    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    audit_id = f'wave49_smoke_{stamp}_audit'
    attempt_id = f'wave49_smoke_{stamp}_attempt'
    try:
        write_json(AUDITS_PATH, read_json(AUDITS_PATH) + [audit(audit_id)])
        write_json(ATTEMPTS_PATH, read_json(ATTEMPTS_PATH) + [attempt(attempt_id, audit_id)])
        before_audits = read_json(AUDITS_PATH)
        before_attempts = read_json(ATTEMPTS_PATH)

        detail = api(f'/api/agent-worker/runtime-audits/{audit_id}')
        assert detail['status'] == 'runtime_audit_found', detail
        assert detail['decision'] == 'runtime_audit_detail', detail
        assert detail['audit_id'] == audit_id, detail
        assert detail['links']['preview_detail'] == f'/api/agent-worker/runtime-previews/preview_{audit_id}', detail
        assert detail['links']['queue_run_ids'] == [f'run_{audit_id}'], detail
        assert detail['links']['confirmation_token'] == f'token_{audit_id}', detail

        attempt_detail = api(f'/api/agent-worker/runtime-confirm-attempts/{attempt_id}')
        assert attempt_detail['status'] == 'runtime_confirm_attempt_found', attempt_detail
        assert attempt_detail['links']['runtime_audit_detail'] == f'/api/agent-worker/runtime-audits/{audit_id}', attempt_detail

        missing = api('/api/agent-worker/runtime-audits/wave49_missing_audit')
        assert missing['status'] == 'runtime_audit_not_found', missing
        assert missing['audit'] is None, missing
        assert missing['links'] == {}, missing

        listed = api('/api/agent-worker/runtime-audits?limit=0')
        assert any(item['id'] == audit_id for item in listed['audits']), listed
        assert read_json(AUDITS_PATH) == before_audits, 'audit detail/listing must be read-only for audits'
        assert read_json(ATTEMPTS_PATH) == before_attempts, 'audit detail/listing must be read-only for attempts'

        html = text('/')
        markers = ['showAgentWorkerRuntimeAuditDetail', '/api/agent-worker/runtime-audits/${encodeURIComponent(auditId)}', 'Runtime audit detail', "showAgentWorkerRuntimeAuditDetail(${JSON.stringify(audit.id || '')})"]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('audit-detail', detail['status'], detail['audit_id'], detail['links']['preview_detail'], detail['links']['queue_run_ids'][0])
        print('attempt-cross-link', attempt_detail['status'], attempt_detail['attempt_id'], attempt_detail['links']['runtime_audit_detail'])
        print('not-found', missing['status'], missing['audit'] is None, missing['links'])
        print('listing-still-works', listed['total'], any(item['id'] == audit_id for item in listed['audits']))
        print('read-only', read_json(AUDITS_PATH) == before_audits, read_json(ATTEMPTS_PATH) == before_attempts)
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if original_audits_exists:
            AUDITS_PATH.write_text(original_audits_text, encoding='utf-8')
        elif AUDITS_PATH.exists():
            AUDITS_PATH.unlink()
        if original_attempts_exists:
            ATTEMPTS_PATH.write_text(original_attempts_text, encoding='utf-8')
        elif ATTEMPTS_PATH.exists():
            ATTEMPTS_PATH.unlink()


if __name__ == '__main__':
    main()
