# Worker orchestration

## When to delegate

Delegate when a **domain specialist** will do better work under a typed contract. Keep mission lifecycle tools on the supervisor.

## Specialists (canonical)

| Worker | Domain |
|--------|--------|
| nora | Research, web, competitors, technical investigation |
| lucas | Software / Daytona engineering |
| maya | Social publishing / integrations |
| leo | Marketing / media |
| sofia | Phone / voice calls |
| dexter | GUI / computer use |
| elena | Durable task operations |
| ivy | Inbox / communications triage |
| quinn | Sales / pipeline / deals |
| aria | Onboarding / success / churn risk |
| kai | Metrics / analytics / reporting |

## Contract rules

- `allowedTools`: native `CHUCK_*` only (no `CHUCK_MISSION_*` on workers).
- `allowedComposioTools` / prefixes: exact verified scopes for that task.
- Split mixed objectives into **dependency-ordered** delegations.
- Summarize useful results for the owner — do not dump raw worker logs or memories.
- Workers may request one missing tool and resume after scope is granted.

## Supervisor retains

- Mission start / replan / verify / complete  
- Approvals and owner questions  
- Cross-worker sequencing and final outcome packaging  
