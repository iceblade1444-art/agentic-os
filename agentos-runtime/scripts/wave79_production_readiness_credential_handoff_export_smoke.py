import json
import subprocess
import sys
import time
from pathlib import Path
from urllib import request

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'agentosctl.py'
BASE = 'http://127.0.0.1:8765'
WATCH_FILES = [
    ROOT / 'config' / 'voice.json',
    ROOT / 'config' / 'voice.local.json',
    ROOT / 'config' / 'agent-worker.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-previews.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-confirm-attempts.json',
    ROOT / 'logs' / 'agent-worker' / 'runtime-ticks.json',
    ROOT / 'logs' / 'agent-queue' / 'runs.json',
    ROOT / 'logs' / 'agent-worker' / 'retention-preset-advice-history.json',
]
MARKERS = [
    'Gemini Credential Handoff',
    'Export credential handoff preview',
    'loadProductionReadinessCredentialHandoffExportPreview',
    '/api/production-readiness/credential-handoff/export?max_chars=1600',
    'production_readiness_credential_handoff_export_preview',
    'markdown_preview',
    'artifact_write_enabled',
    'config_writes_enabled',
]


def api(path):
    with request.urlopen(BASE + path, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))


def text(path):
    with request.urlopen(BASE + path, timeout=15) as resp:
        return resp.read().decode('utf-8')


def file_snapshot(paths):
    return {str(path): path.read_text(encoding='utf-8') if path.exists() else None for path in paths}


def run_cli(*args):
    proc = subprocess.run([sys.executable, str(CLI), '--workspace', str(ROOT), *args], text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"CLI failed {' '.join(args)}\nSTDOUT={proc.stdout}\nSTDERR={proc.stderr}")
    return json.loads(proc.stdout)


def wait_ready():
    last = None
    for _ in range(30):
        try:
            status = api('/api/status')
            if status.get('workspace'):
                return status
        except Exception as exc:
            last = exc
            time.sleep(0.5)
    raise RuntimeError(f'dashboard not ready: {last}')


def main():
    status = wait_ready()
    before = file_snapshot(WATCH_FILES)

    handoff = api('/api/production-readiness/credential-handoff')
    preview = api('/api/production-readiness/credential-handoff/export?max_chars=900')
    full_preview = api('/api/production-readiness/credential-handoff/export?max_chars=0')
    readiness = api('/api/production-readiness')
    voice_health = api('/api/voice-health')
    release = run_cli('release', 'check', '--pretty')
    html = text('/')
    after = file_snapshot(WATCH_FILES)

    assert preview['status'] == 'ok', preview
    assert preview['decision'] == 'production_readiness_credential_handoff_export_preview', preview
    assert preview['dry_run'] is True and preview['will_apply'] is False, preview
    assert preview['writes_enabled'] is False and preview['read_only'] is True, preview
    assert preview['artifact_path'] is None and preview['artifact_relpath'] is None, preview
    assert preview['safety'] == {
        'read_only': True,
        'artifact_write_enabled': False,
        'history_writes_enabled': False,
        'operational_ledgers_mutated': False,
        'config_writes_enabled': False,
        'voice_session_started': False,
    }, preview
    credential = preview['credential_handoff']
    markdown = preview['export_preview']['markdown_preview']
    assert credential['handoff_status'] == 'missing_credentials', credential
    assert credential['remaining_external_blocker'] == 'gemini_live', credential
    assert credential['required_credentials'] == ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], credential
    assert credential['actions_stay_routed_through_command_bridge'] is True, credential
    assert credential == handoff['credential_handoff'], 'export preview must derive from handoff payload'
    assert preview['export_preview']['format'] == 'markdown', preview['export_preview']
    assert preview['export_preview']['title'] == 'AgentOS Gemini Credential Handoff', preview['export_preview']
    assert preview['export_preview']['max_chars'] == 900, preview['export_preview']
    assert preview['export_preview']['content_length'] > 900, preview['export_preview']
    assert len(markdown) == 900, preview['export_preview']
    assert preview['export_preview']['truncated'] is True, preview['export_preview']
    assert markdown.startswith('# AgentOS Gemini Credential Handoff'), markdown
    assert 'production_readiness_credential_handoff_export_preview' in markdown, markdown
    assert 'GEMINI_API_KEY' in markdown and 'GOOGLE_API_KEY' in markdown, markdown
    assert 'actions_stay_routed_through_command_bridge' in markdown, markdown
    assert full_preview['export_preview']['max_chars'] == 0, full_preview['export_preview']
    assert full_preview['export_preview']['truncated'] is False, full_preview['export_preview']
    assert len(full_preview['export_preview']['markdown_preview']) == full_preview['export_preview']['content_length'], full_preview['export_preview']
    assert '[REDACTED]' in full_preview['export_preview']['markdown_preview'] or credential['current_status']['has_inline_key'] is False
    assert 'super-secret' not in json.dumps(full_preview, ensure_ascii=False).lower(), full_preview

    providers = {item['provider']: item for item in voice_health['providers']}
    assert providers['gemini_live']['ready'] is False, providers['gemini_live']
    assert 'missing_credentials' in providers['gemini_live']['reasons'], providers['gemini_live']
    assert readiness['status'] == 'ready_with_optional_blockers', readiness
    assert readiness['readiness']['local_ready'] is True, readiness
    assert readiness['readiness']['production_ready'] is False, readiness
    assert readiness['required_blockers'] == [], readiness
    assert readiness['optional_blockers'] == ['gemini_live'], readiness
    assert release['status'] == 'ready_local', release
    assert release['optional_blockers'] == ['gemini_live'], release
    assert all(marker in html for marker in MARKERS), MARKERS
    assert after == before, 'credential handoff export preview must be read-only over watched files'

    run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
    worker_status = run_cli('agent', 'worker', 'status', '--pretty')

    print('dashboard-ready', BASE, status.get('workspace'))
    print('handoff-export', preview['status'], preview['decision'], preview['dry_run'], preview['will_apply'], preview['writes_enabled'], preview['read_only'], preview['artifact_path'])
    print('credential-status', credential['handoff_status'], credential['remaining_external_blocker'], credential['current_status']['ready'], credential['current_status']['reasons'])
    print('preview-shape', preview['export_preview']['format'], preview['export_preview']['max_chars'], preview['export_preview']['content_length'], len(markdown), preview['export_preview']['truncated'])
    print('full-preview', full_preview['export_preview']['max_chars'], full_preview['export_preview']['truncated'], len(full_preview['export_preview']['markdown_preview']) == full_preview['export_preview']['content_length'])
    print('markdown-markers', all(item in markdown for item in ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'actions_stay_routed_through_command_bridge']))
    print('safety', preview['safety'])
    print('readiness', readiness['status'], readiness['readiness'], readiness['required_blockers'], readiness['optional_blockers'])
    print('voice-health-gemini', providers['gemini_live'])
    print('read-only-files', {Path(key).name: after[key] == before[key] for key in before})
    print('frontend-markers', True, ','.join(MARKERS))
    print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])


if __name__ == '__main__':
    main()
