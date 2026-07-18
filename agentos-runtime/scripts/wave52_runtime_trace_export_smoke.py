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
        'approval_id': 'approval_wave52_smoke',
        'planned': len(run_ids),
        'executed': len(run_ids),
        'queue_ids': [f'queue_{run_id}' for run_id in run_ids],
        'queue_run_ids': run_ids,
        'runtime_audit_id': audit_id,
        'confirmation': {'token': f'token_{one_shot_run_id}', 'accepted': True},
        'execution_policy': {'manual_only': True, 'confirmation_required': True},
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
        'preflight_reason': 'wave52 smoke token pending',
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
        'trigger': 'wave52_smoke',
        'worker': 'dashboard-agent',
        'approval_id': 'approval_wave52_smoke',
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
        'project': 'wave52-smoke',
        'task_id': run_id[-4:],
        'objective': 'Wave 52 runtime trace export smoke',
        'owner': 'dashboard-agent',
        'worker': 'dashboard-agent',
        'executor': 'dashboard-agent',
        'trigger': 'runtime_confirm_execute',
        'status': 'done',
        'started_at': datetime.now().replace(microsecond=0).isoformat(),
        'completed_at': datetime.now().replace(microsecond=0).isoformat(),
        'artifact_path': f'C:/tmp/{run_id}.md',
        'log_path': f'C:/tmp/{run_id}.log',
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
    one_shot_run_id = f'wave52_smoke_{stamp}_trace'
    preview_id = f'wave52_smoke_{stamp}_preview'
    audit_id = f'wave52_smoke_{stamp}_audit'
    attempt_id = f'wave52_smoke_{stamp}_attempt'
    run_ids = [f'wave52_smoke_{stamp}_run_a', f'wave52_smoke_{stamp}_run_b']
    export_path = ROOT / 'artifacts' / 'agent-worker' / 'runtime-traces' / f'{one_shot_run_id}_trace.md'
    export_existed = export_path.exists()
    export_original = export_path.read_text(encoding='utf-8') if export_existed else None
    try:
        write_json(PREVIEWS_PATH, read_json(PREVIEWS_PATH) + [preview(preview_id, one_shot_run_id, audit_id, run_ids)])
        write_json(ATTEMPTS_PATH, read_json(ATTEMPTS_PATH) + [attempt(attempt_id, preview_id, one_shot_run_id, audit_id, run_ids)])
        write_json(AUDITS_PATH, read_json(AUDITS_PATH) + [audit(audit_id, preview_id, one_shot_run_id, run_ids)])
        write_json(RUNS_PATH, read_json(RUNS_PATH) + [queue_run(run_ids[0], preview_id, one_shot_run_id), queue_run(run_ids[1], preview_id, one_shot_run_id)])
        before = {path: read_json(path) for path in [PREVIEWS_PATH, ATTEMPTS_PATH, AUDITS_PATH, RUNS_PATH]}

        export = api(f'/api/agent-worker/runtime-traces/{one_shot_run_id}/export')
        assert export['status'] == 'runtime_trace_exported', export
        assert export['decision'] == 'runtime_trace_export', export
        assert export['trace_status'] == 'runtime_trace_found', export
        assert export['one_shot_run_id'] == one_shot_run_id, export
        assert export['preview_id'] == preview_id, export
        assert export['runtime_audit_id'] == audit_id, export
        assert export['confirm_attempt_ids'] == [attempt_id], export
        assert export['queue_run_ids'] == run_ids, export
        assert export['artifact_relpath'] == f'artifacts/agent-worker/runtime-traces/{one_shot_run_id}_trace.md', export
        assert Path(export['artifact_path']) == export_path, export
        assert export_path.exists(), export
        content = export_path.read_text(encoding='utf-8')
        assert f'# Runtime Trace Export — {one_shot_run_id}' in content, content
        assert '## Safety Metadata' in content, content
        assert 'Operational ledgers mutated: false' in content, content
        assert 'Artifact only write: true' in content, content
        assert preview_id in content and attempt_id in content and audit_id in content, content
        assert run_ids[0] in content and run_ids[1] in content, content
        assert f'token_{one_shot_run_id}' not in content, content
        assert '[REDACTED]' in content, content

        trace = api(f'/api/agent-worker/runtime-traces/{one_shot_run_id}')
        assert trace['status'] == 'runtime_trace_found', trace
        assert trace['counts'] == {'previews': 1, 'confirmation_attempts': 1, 'runtime_audits': 1, 'queue_runs': 2}, trace

        missing = api('/api/agent-worker/runtime-traces/wave52_missing_trace/export')
        assert missing['status'] == 'runtime_trace_export_not_found', missing
        assert missing['artifact_path'] is None, missing
        assert missing['artifact_relpath'] is None, missing

        assert {path: read_json(path) for path in [PREVIEWS_PATH, ATTEMPTS_PATH, AUDITS_PATH, RUNS_PATH]} == before, 'trace export must not mutate operational ledgers'

        html = text('/')
        markers = [
            'exportAgentWorkerRuntimeTrace',
            '/api/agent-worker/runtime-traces/${encodeURIComponent(oneShotRunId)}/export',
            'Runtime trace export',
            "exportAgentWorkerRuntimeTrace(${JSON.stringify(preview.one_shot_run_id || '')})",
            "exportAgentWorkerRuntimeTrace(${JSON.stringify(attempt.one_shot_run_id || '')})",
            "exportAgentWorkerRuntimeTrace(${JSON.stringify(audit.one_shot_run_id || '')})",
            "exportAgentWorkerRuntimeTrace(${JSON.stringify(run.one_shot_run_id || (run.execution_context || {}).one_shot_run_id || '')})",
        ]
        assert all(marker in html for marker in markers), markers

        run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
        worker_status = run_cli('agent', 'worker', 'status', '--pretty')

        print('dashboard-ready', BASE, status.get('workspace'))
        print('trace-export', export['status'], export['one_shot_run_id'], export['artifact_relpath'])
        print('export-content', 'redacted=True', 'safety=True', 'runs=2')
        print('trace-still-works', trace['status'], trace['counts'])
        print('not-found-export', missing['status'], missing['artifact_path'], missing['artifact_relpath'])
        print('read-only', {path.name: read_json(path) == before[path] for path in before})
        print('frontend-markers', True, ','.join(markers))
        print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])
    finally:
        for path, (exists, content) in originals.items():
            if exists:
                path.write_text(content, encoding='utf-8')
            elif path.exists():
                path.unlink()
        if export_existed:
            export_path.write_text(export_original, encoding='utf-8')
        elif export_path.exists():
            export_path.unlink()


if __name__ == '__main__':
    main()
