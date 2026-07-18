# Safe Action Workflow

## Purpose
Prevent AgentOS from taking risky external actions without explicit user approval.

## Risk classes

### Low — auto allowed
Examples:
- `read_file`
- `write_file`
- `create_draft`
- `summarize`
- `research`
- `create_task`
- `run_test`

### Medium — approval by default
Unknown actions default to medium risk and require approval.

### High — approval required
Examples:
- `send_email`
- `mass_email`
- `publish`
- `deploy`
- `delete_file`
- `payment`
- `change_credentials`
- `production_change`

## CLI usage

Check risk without creating an approval:

```bash
python agentosctl.py risk check send_email "Send outreach email"
```

Request an action. If risky, this creates an approval record:

```bash
python agentosctl.py risk request deploy "Deploy dashboard to production"
```

List pending approvals:

```bash
python agentosctl.py approval list --status pending
```

Approve:

```bash
python agentosctl.py approval approve approval_xxxxx
```

Deny:

```bash
python agentosctl.py approval deny approval_xxxxx
```

## Agent rule
Specialist agents must call the risk workflow before external actions. If `requires_approval` is true, they must stop after creating the approval record and wait for approval.
