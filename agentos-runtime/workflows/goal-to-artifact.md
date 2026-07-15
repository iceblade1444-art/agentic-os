# AgentOS Goal Workflow

## Purpose
Turn a single user goal into a verified artifact or a clearly blocked task.

## Steps

1. **Capture goal**
   - Save the exact user goal.
   - Assign a project slug.

2. **Load context**
   - Read relevant memory files.
   - Read relevant SOPs.
   - Ignore unrelated memory.

3. **Create project brief**
   - Define goal, assumptions, acceptance criteria, risks, and artifacts.

4. **Create task graph**
   - Break the project into small tasks.
   - Assign owners.
   - Mark dependencies and approval gates.

5. **Execute low-risk tasks**
   - Research, drafts, local files, tests.

6. **Queue approvals for risky tasks**
   - Email sends, deploys, publishing, deletes, payments.

7. **QA verification**
   - Verify acceptance criteria with concrete checks.

8. **Update memory/SOPs only if durable**
   - Do not save temporary run progress as memory.

9. **Final report**
   - List artifacts, validation evidence, blockers, and next actions.

## Standard task card

```yaml
id: "task_001"
project: ""
objective: ""
owner: ""
status: "planned"
depends_on: []
risk_level: "low"
requires_approval: false
acceptance_criteria: []
artifacts: []
block_reason: null
```
