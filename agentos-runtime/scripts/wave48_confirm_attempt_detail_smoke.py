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


def read_attempts():
    if not ATTEMPTS_PATH.exists():
        return []
    return json.loads(ATTEMPTS_PATH.read_text(encoding='utf-8'))


def write_attempts(items):
    ATTEMPTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    ATTEMPTS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding='utf-8')


def attempt(attempt_id, runtime_called=True):
    final_status = 'runtime_execute_completed' if runtime_called else 'confirmation_preflight_blocked'
    preflight_status = 'confirmation_token_pending' if runtime_called else 'confirmation_token_expired'
    return {
        'id': attempt_id,
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'status': 'runtime_confirm_attempt_recorded',
        'final_status': final_status,
        'decision': final_status,
        'runtime_called': runtime_called,
        'preflight_status': preflight_status,
        'preflight_can_execute': runtime_called,
        'preflight_reason': f'reason_{preflight_status}',
        'preview_id': f'preview_{attempt_id}',
        'one_shot_run_id': f'runtime_once_{attempt_id}',
        'confirmation_token': f'token_{attempt_id}',
        'token_status': 'consumed' if runtime_called else 'expired',
        'executed': 1 if runtime_called else 0,
        'runtime_audit_id': f'runtime_tick_{attempt_id}' if runtime_called else None,
        'queue_run_ids': [f'run_{attempt_id}'] if runtime_called else [],
        'preflight': {'status': preflight_status, 'can_execute': runtime_called},
        'result_summary': {'status': final_status, 'executed': 1 if runtime_called else 0},
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

    original_exists = ATTEMPTS_PATH.exists()
    original_text = ATTEMPTS_PATH.read_text(encoding='utf-8') if original_exists else None
    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    ok_id = f'wave48_smoke_{stamp}_ok'
    blocked_id = f'wave48_smoke_{stamp}_blocked'
    try:
        injected = [attempt(ok_id, True), attempt(blocked_id, False)]
        write_attempts(read_attempts() + injected)
        before = read_attempts()

        detail = api(f'/api/agent-worker/runtime-confirm-attempts/{ok_id}')
        assert detail['status'] == 'runtime_confirm_attempt_found', detail
        assert detail['decision'] == 'runtime_confirm_attempt_detail', detail
        assert detail['attempt_id'] == ok_id, detail
        assert detail['preview_id'] == f'preview_{ok_id}', detail
        assert detail['one_shot_run_id'] == f'runtime_once_{ok_id}', detail
        assert detail['runtime_audit_id'] == f'runtime_tick_{ok_id}', detail
        assert detail['queue_run_ids'] == [f'run_{ok_id}'], detail
        assert detail['links']['preview_detail'] == f'/api/agent-worker/runtime-previews/preview_{ok_id}', detail

        blocked = api(f'/api/agent-worker/runtime-confirm-attempts/{blocked_id}')
        assert blocked['status'] == 'runtime_confirm_attempt_found', blocked
        assert blocked['runtime_called'] is False, blocked
        assert blocked['runtime_audit_id'] is None, blocked
        assert blocked['queue_run_ids'] == [], blocked

        missing = api('/api/agent-worker/runtime-confirm-attempts/wave48_missing_attempt')
        assert missing['status'] == 'runtime_confirm_attempt_not_found', missing
        assert missing['attempt'] is None, missing
        assert missing['links'] == {}, missing

        listed = api('/api/agent-worker/runtime-confirm-attempts?final_status=confirmation_preflight_blocked&limit=0')
        assert any(item['id'] == blocked_id for item in listed['attempts']), listed
        assert read_attempts() == before, 'detail lookup must be read-only'

        html = text('/')
        markers = ['showAgentWorkerRuntimeConfirmAttemptDetail', '/api/agent-worker/runtime-confirm-attempts/${encodeURIComponent(attemptId)}', 'Confirm attempt detail', "showAgentWorkerRuntimeConfirmAttemptDetail(${JSON.stringify(attempt.id || '')})"]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('attempt-detail', detail['status'], detail['attempt_id'], detail['links']['preview_detail'], detail['runtime_audit_id'], detail['queue_run_ids'][0])
        print('blocked-detail', blocked['status'], blocked['attempt_id'], blocked['runtime_called'], blocked['runtime_audit_id'], blocked['queue_run_ids'])
        print('not-found', missing['status'], missing['attempt'] is None, missing['links'])
        print('listing-still-works', listed['status'], any(item['id'] == blocked_id for item in listed['attempts']))
        print('read-only', read_attempts() == before)
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if original_exists:
            ATTEMPTS_PATH.write_text(original_text, encoding='utf-8')
        elif ATTEMPTS_PATH.exists():
            ATTEMPTS_PATH.unlink()


if __name__ == '__main__':
    main()
