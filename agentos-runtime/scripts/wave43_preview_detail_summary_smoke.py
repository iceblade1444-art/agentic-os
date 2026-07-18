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


def smoke_preview(preview_id, token_status, execution_status=None):
    execution_status = execution_status or ('pending_confirmation' if token_status == 'pending' else token_status)
    return {
        'id': preview_id,
        'preview_id': preview_id,
        'one_shot_run_id': f'runtime_once_{preview_id}',
        'status': 'runtime_execute_preview',
        'execution_status': execution_status,
        'token_status': token_status,
        'expires_at': '2099-01-01T00:00:00',
        'created_at': datetime.now().replace(microsecond=0).isoformat(),
        'worker': 'coding-agent',
        'approval_id': 'approval_wave43_smoke',
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
    prefix = f'wave43_smoke_{stamp}'
    pending_id = f'{prefix}_pending'
    consumed_id = f'{prefix}_consumed'
    expired_id = f'{prefix}_expired'
    revoked_id = f'{prefix}_revoked'
    try:
        injected = [
            smoke_preview(pending_id, 'pending'),
            smoke_preview(consumed_id, 'consumed', execution_status='runtime_execute_completed'),
            smoke_preview(expired_id, 'expired'),
            smoke_preview(revoked_id, 'revoked'),
        ]
        write_previews(read_previews() + injected)

        cli_detail = run_cli('agent', 'worker', 'runtime-preview-detail', '--preview-id', pending_id, '--pretty')
        assert cli_detail['status'] == 'runtime_preview_found', cli_detail
        assert cli_detail['preview']['confirmation']['token'] == f'token_{pending_id}', cli_detail

        api_detail = api(f'/api/agent-worker/runtime-previews/{pending_id}')
        assert api_detail['status'] == 'runtime_preview_found', api_detail
        assert api_detail['token_status'] == 'pending', api_detail

        cli_list = run_cli('agent', 'worker', 'runtime-previews', '--limit', '0', '--pretty')
        summary = cli_list['summary']
        assert summary['pending'] >= 1 and summary['consumed'] >= 1 and summary['expired'] >= 1 and summary['revoked'] >= 1, summary

        api_filtered = api('/api/agent-worker/runtime-previews?status=pending&limit=0')
        pending_ids = {item.get('preview_id') for item in api_filtered['previews']}
        assert pending_id in pending_ids, api_filtered
        assert 'summary' in api_filtered and api_filtered['summary']['pending'] >= 1, api_filtered

        not_found = run_cli('agent', 'worker', 'runtime-preview-detail', '--preview-id', f'{prefix}_missing', '--pretty')
        assert not_found['status'] == 'runtime_preview_not_found', not_found

        html = text('/')
        markers = ['showAgentWorkerRuntimePreviewDetail', 'useAgentWorkerRuntimePreviewToken', 'copyAgentWorkerRuntimePreviewToken', 'runtime-preview-detail', 'summary.pending', 'Use token', 'Copy token']
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('cli-detail', cli_detail['status'], cli_detail['preview_id'], cli_detail['token_status'], cli_detail['preview']['confirmation']['token'])
        print('api-detail', api_detail['status'], api_detail['preview_id'], api_detail['token_status'])
        print('summary-counts', summary['pending'], summary['consumed'], summary['expired'], summary['revoked'])
        print('api-filter-summary', api_filtered['filters']['status'], api_filtered['matched'], pending_id in pending_ids, api_filtered['summary']['pending'])
        print('not-found', not_found['status'], not_found['preview_id'])
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        if original_exists:
            PREVIEWS_PATH.write_text(original_text, encoding='utf-8')
        elif PREVIEWS_PATH.exists():
            PREVIEWS_PATH.unlink()


if __name__ == '__main__':
    main()
