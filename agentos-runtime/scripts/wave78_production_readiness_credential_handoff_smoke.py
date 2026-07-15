import json
import subprocess
import sys
import time
from pathlib import Path
from urllib import request

ROOT = Path('C:/Users/User/AgentOS')
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
    'productionReadinessCredentialHandoff',
    'loadProductionReadinessCredentialHandoff',
    '/api/production-readiness/credential-handoff',
    'production_readiness_credential_handoff',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'actions_stay_routed_through_command_bridge',
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
    readiness = api('/api/production-readiness')
    voice_health = api('/api/voice-health')
    release = run_cli('release', 'check', '--pretty')
    html = text('/')
    after = file_snapshot(WATCH_FILES)

    assert handoff['status'] == 'ok', handoff
    assert handoff['decision'] == 'production_readiness_credential_handoff', handoff
    assert handoff['dry_run'] is True and handoff['will_apply'] is False, handoff
    assert handoff['writes_enabled'] is False and handoff['read_only'] is True, handoff
    assert handoff['artifact_path'] is None and handoff['artifact_relpath'] is None, handoff
    assert handoff['safety'] == {
        'read_only': True,
        'artifact_write_enabled': False,
        'history_writes_enabled': False,
        'operational_ledgers_mutated': False,
        'config_writes_enabled': False,
        'voice_session_started': False,
    }, handoff

    credential = handoff['credential_handoff']
    assert credential['provider'] == 'gemini_live', credential
    assert credential['handoff_status'] == 'missing_credentials', credential
    assert credential['remaining_external_blocker'] == 'gemini_live', credential
    assert credential['required_credentials'] == ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], credential
    assert credential['preferred_credential'] == 'GEMINI_API_KEY', credential
    assert credential['fallback_credential'] == 'GOOGLE_API_KEY', credential
    assert credential['recommended_storage'] == 'environment_variable', credential
    assert credential['do_not_store_in_dashboard'] is True, credential
    assert credential['actions_stay_routed_through_command_bridge'] is True, credential
    assert credential['approval_gates_remain_required'] is True, credential
    assert credential['current_status']['ready'] is False, credential
    assert 'missing_credentials' in credential['current_status']['reasons'], credential
    assert [step['id'] for step in credential['setup_steps']] == [
        'obtain_google_ai_studio_key',
        'set_environment_variable',
        'enable_gemini_live_provider',
        'restart_dashboard_backend',
        'verify_voice_status',
        'run_gemini_live_probe',
        'run_safe_command_session',
    ], credential
    assert 'setx GEMINI_API_KEY' in credential['setup_steps'][1]['windows_user_command'], credential
    assert 'export GEMINI_API_KEY' in credential['setup_steps'][1]['git_bash_command'], credential
    assert credential['verification_commands'][-1].endswith('release check --pretty'), credential
    assert 'super-secret' not in json.dumps(handoff, ensure_ascii=False).lower(), handoff

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
    assert after == before, 'credential handoff must be read-only over watched files'

    run_cli('agent', 'worker', 'configure', '--worker', 'dashboard-agent', '--max-items-per-tick', '1', '--queue-id', '', '--project', '', '--owner', '', '--runtime-mode', 'dry_run', '--pretty')
    worker_status = run_cli('agent', 'worker', 'status', '--pretty')

    print('dashboard-ready', BASE, status.get('workspace'))
    print('handoff', handoff['status'], handoff['decision'], handoff['dry_run'], handoff['will_apply'], handoff['writes_enabled'], handoff['read_only'])
    print('credential-status', credential['handoff_status'], credential['remaining_external_blocker'], credential['current_status']['ready'], credential['current_status']['reasons'])
    print('required-credentials', credential['required_credentials'], credential['preferred_credential'], credential['fallback_credential'])
    print('setup-steps', [step['id'] for step in credential['setup_steps']])
    print('verification-commands', credential['verification_commands'])
    print('safety', handoff['safety'])
    print('readiness', readiness['status'], readiness['readiness'], readiness['required_blockers'], readiness['optional_blockers'])
    print('voice-health-gemini', providers['gemini_live'])
    print('read-only-files', {Path(key).name: after[key] == before[key] for key in before})
    print('frontend-markers', True, ','.join(MARKERS))
    print('worker-reset', worker_status['status'], worker_status['runtime']['mode'], worker_status['config']['enabled'], worker_status['config']['filters'])


if __name__ == '__main__':
    main()
