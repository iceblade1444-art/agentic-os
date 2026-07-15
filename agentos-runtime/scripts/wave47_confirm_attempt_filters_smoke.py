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


def attempt(attempt_id, final_status, runtime_called, preflight_status, executed=0):
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
        'executed': executed,
        'runtime_audit_id': f'runtime_tick_{attempt_id}' if runtime_called else None,
        'queue_run_ids': [f'run_{attempt_id}'] if runtime_called else [],
        'preflight': {'status': preflight_status, 'can_execute': runtime_called, 'confirmation': {'reason': 'token_pending' if runtime_called else 'token_expired'}},
        'result_summary': {'status': final_status, 'executed': executed},
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
    prefix = f'wave47_smoke_{stamp}'
    try:
        injected = [
            attempt(f'{prefix}_ok1', 'runtime_execute_completed', True, 'confirmation_token_pending', 1),
            attempt(f'{prefix}_expired', 'confirmation_preflight_blocked', False, 'confirmation_token_expired', 0),
            attempt(f'{prefix}_revoked', 'confirmation_preflight_blocked', False, 'confirmation_token_revoked', 0),
            attempt(f'{prefix}_ok2', 'runtime_execute_completed', True, 'confirmation_token_pending', 1),
        ]
        write_attempts(read_attempts() + injected)
        before = read_attempts()

        blocked = api('/api/agent-worker/runtime-confirm-attempts?final_status=confirmation_preflight_blocked&limit=0')
        blocked_ids = [item['id'] for item in blocked['attempts'] if item['id'].startswith(prefix)]
        assert blocked['status'] == 'ok', blocked
        assert blocked['filters']['final_status'] == 'confirmation_preflight_blocked', blocked
        assert len(blocked_ids) == 2, blocked
        assert blocked['summary']['final_status']['confirmation_preflight_blocked'] >= 2, blocked

        expired = api('/api/agent-worker/runtime-confirm-attempts?runtime_called=false&preflight_status=confirmation_token_expired&limit=0')
        expired_ids = [item['id'] for item in expired['attempts'] if item['id'].startswith(prefix)]
        assert expired['filters']['runtime_called'] is False, expired
        assert expired['filters']['preflight_status'] == 'confirmation_token_expired', expired
        assert f'{prefix}_expired' in expired_ids, expired

        called = api('/api/agent-worker/runtime-confirm-attempts?runtime_called=true&limit=1')
        assert called['filters']['runtime_called'] is True, called
        assert called['count'] == 1, called
        assert called['matched'] >= 2, called
        assert called['summary']['runtime_called']['true'] >= 2, called

        assert read_attempts() == before, 'attempt filters must be read-only'

        html = text('/')
        markers = ['attemptFilters', "loadAgentWorkerRuntimeConfirmAttempts({ final_status: 'confirmation_preflight_blocked' })", "loadAgentWorkerRuntimeConfirmAttempts({ runtime_called: 'true' })", "loadAgentWorkerRuntimeConfirmAttempts({ preflight_status: 'confirmation_token_expired' })", 'attempts summary', 'summary.final_status', 'summary.runtime_called', 'summary.preflight_status']
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('blocked-filter', blocked['filters']['final_status'], len(blocked_ids), blocked['summary']['final_status']['confirmation_preflight_blocked'])
        print('expired-filter', expired['filters']['runtime_called'], expired['filters']['preflight_status'], f'{prefix}_expired' in expired_ids)
        print('called-limit', called['filters']['runtime_called'], called['count'], called['matched'], called['summary']['runtime_called']['true'])
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
