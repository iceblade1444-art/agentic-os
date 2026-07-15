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
PREVIEWS_PATH = ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json'


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


def read_previews():
    if not PREVIEWS_PATH.exists():
        return []
    return json.loads(PREVIEWS_PATH.read_text(encoding='utf-8'))


def write_previews(items):
    PREVIEWS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PREVIEWS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding='utf-8')


def smoke_preview(preview_id, token_status, execution_status=None, expires_at='2099-01-01T00:00:00'):
    execution_status = execution_status or ('pending_confirmation' if token_status == 'pending' else token_status)
    return {
        'id': preview_id,
        'preview_id': preview_id,
        'one_shot_run_id': f'runtime_once_{preview_id}',
        'status': 'runtime_execute_preview',
        'execution_status': execution_status,
        'token_status': token_status,
        'expires_at': expires_at,
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'worker': 'coding-agent',
        'approval_id': 'approval_wave44_smoke',
        'planned': 1,
        'executed': 0,
        'queue_ids': [f'queue_{preview_id}'],
        'confirmation': {'required': True, 'accepted': False, 'token': f'token_{preview_id}'},
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

    original_exists = PREVIEWS_PATH.exists()
    original_text = PREVIEWS_PATH.read_text(encoding='utf-8') if original_exists else None
    stamp = datetime.now().strftime('%Y%m%d%H%M%S')
    prefix = f'wave44_smoke_{stamp}'
    pending_id = f'{prefix}_pending'
    stale_id = f'{prefix}_stale'
    revoked_id = f'{prefix}_revoked'
    consumed_id = f'{prefix}_consumed'
    try:
        injected = [
            smoke_preview(pending_id, 'pending', expires_at='2099-01-01T00:00:00'),
            smoke_preview(stale_id, 'pending', expires_at='2000-01-01T00:00:00'),
            smoke_preview(revoked_id, 'revoked'),
            smoke_preview(consumed_id, 'consumed', execution_status='runtime_execute_completed'),
        ]
        write_previews(read_previews() + injected)
        before = read_previews()

        cli_pending = run_cli('agent', 'worker', 'runtime-preview-validate-token', '--confirmation-token', f'token_{pending_id}', '--pretty')
        assert cli_pending['status'] == 'confirmation_token_pending' and cli_pending['can_execute'] is True, cli_pending
        assert cli_pending['will_execute'] is False and cli_pending['decision'] == 'confirmation_preflight', cli_pending

        cli_stale = run_cli('agent', 'worker', 'runtime-preview-validate-token', '--confirmation-token', f'token_{stale_id}', '--pretty')
        assert cli_stale['status'] == 'confirmation_token_expired' and cli_stale['token_status'] == 'expired', cli_stale
        assert read_previews() == before, 'preflight must not mutate preview ledger'

        api_revoked = api('/api/agent-worker/runtime-preview/validate-token', method='POST', payload={'confirmation_token': f'token_{revoked_id}'})
        assert api_revoked['status'] == 'confirmation_token_revoked' and api_revoked['confirmation']['reason'] == 'token_revoked', api_revoked

        api_by_preview_id = api('/api/agent-worker/runtime-preview/validate-token', method='POST', payload={'preview_id': pending_id})
        assert api_by_preview_id['status'] == 'confirmation_token_pending', api_by_preview_id
        assert api_by_preview_id['confirmation_token'] == f'token_{pending_id}', api_by_preview_id

        cli_missing = run_cli('agent', 'worker', 'runtime-preview-validate-token', '--confirmation-token', f'token_{prefix}_missing', '--pretty')
        assert cli_missing['status'] == 'confirmation_token_not_found' and cli_missing['can_execute'] is False, cli_missing

        html = text('/')
        markers = ['runtime-preview-validate-token', '/api/agent-worker/runtime-preview/validate-token', 'validateAgentWorkerRuntimePreviewToken', 'Preflight token', 'confirmation_preflight']
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('cli-preflight-pending', cli_pending['status'], cli_pending['preview_id'], cli_pending['can_execute'], cli_pending['will_execute'])
        print('cli-preflight-stale', cli_stale['status'], cli_stale['preview_id'], cli_stale['token_status'], read_previews() == before)
        print('api-preflight-revoked', api_revoked['status'], api_revoked['preview_id'], api_revoked['confirmation']['reason'])
        print('api-preflight-preview-id', api_by_preview_id['status'], api_by_preview_id['preview_id'], api_by_preview_id['confirmation_token'])
        print('cli-preflight-missing', cli_missing['status'], cli_missing['token_status'], cli_missing['confirmation']['reason'])
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if original_exists:
            PREVIEWS_PATH.write_text(original_text, encoding='utf-8')
        elif PREVIEWS_PATH.exists():
            PREVIEWS_PATH.unlink()


if __name__ == '__main__':
    main()
