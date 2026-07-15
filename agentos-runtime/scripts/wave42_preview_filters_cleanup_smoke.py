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
    prefix = f'wave42_smoke_{stamp}'
    try:
        injected = [
            smoke_preview(f'{prefix}_pending_future', 'pending', expires_at='2099-01-01T00:00:00'),
            smoke_preview(f'{prefix}_pending_past', 'pending', expires_at='2000-01-01T00:00:00'),
            smoke_preview(f'{prefix}_consumed', 'consumed', execution_status='runtime_execute_completed'),
            smoke_preview(f'{prefix}_revoked', 'revoked'),
        ]
        write_previews(read_previews() + injected)

        cli_pending = run_cli('agent', 'worker', 'runtime-previews', '--status', 'pending', '--limit', '0', '--pretty')
        pending_ids = {item.get('preview_id') for item in cli_pending['previews']}
        assert f'{prefix}_pending_future' in pending_ids and f'{prefix}_pending_past' in pending_ids, cli_pending
        assert cli_pending['filters']['status'] == 'pending'

        api_revoked = api('/api/agent-worker/runtime-previews?status=revoked&limit=0')
        revoked_ids = {item.get('preview_id') for item in api_revoked['previews']}
        assert f'{prefix}_revoked' in revoked_ids, api_revoked
        assert api_revoked['filters']['status'] == 'revoked'

        expired_result = run_cli('agent', 'worker', 'runtime-preview-expire-stale', '--pretty')
        assert f'{prefix}_pending_past' in expired_result['expired_preview_ids'], expired_result

        api_expired = api('/api/agent-worker/runtime-previews?status=expired&limit=0')
        expired = {item.get('preview_id'): item for item in api_expired['previews']}
        assert f'{prefix}_pending_past' in expired, api_expired
        assert expired[f'{prefix}_pending_past']['confirmation']['reason'] == 'token_expired'

        html = text('/')
        markers = ['runtime-preview-expire-stale', "loadAgentWorkerRuntimePreviews('pending')", "loadAgentWorkerRuntimePreviews('consumed')", "loadAgentWorkerRuntimePreviews('expired')", "loadAgentWorkerRuntimePreviews('revoked')", 'previewLifecycleFilter']
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('cli-filter-pending', cli_pending['filters']['status'], cli_pending['matched'], f'{prefix}_pending_future' in pending_ids, f'{prefix}_pending_past' in pending_ids)
        print('api-filter-revoked', api_revoked['filters']['status'], api_revoked['matched'], f'{prefix}_revoked' in revoked_ids)
        print('cli-expire-stale', expired_result['status'], expired_result['expired'], f'{prefix}_pending_past' in expired_result['expired_preview_ids'])
        print('api-filter-expired', api_expired['filters']['status'], api_expired['matched'], f'{prefix}_pending_past' in expired)
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if original_exists:
            PREVIEWS_PATH.write_text(original_text, encoding='utf-8')
        elif PREVIEWS_PATH.exists():
            PREVIEWS_PATH.unlink()


if __name__ == '__main__':
    main()
