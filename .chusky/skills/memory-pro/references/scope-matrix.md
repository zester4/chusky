# Memory scope matrix

| Scope | Meaning | Examples | Never assume |
|---|---|---|---|
| personal | Private owner facts and preferences | timezone, writing style, dietary preference | It applies to a company |
| organization | Durable company truth | policy, brand rule, approved tool | Every team or client sees every detail |
| team | A bounded group inside an organization | sales process, team goals | It applies outside the team |
| project | Work with a defined objective | launch decision, project deadline | It remains current after completion |
| client | Relationship and account context | contact role, account history | It is safe to reveal in every meeting |
| meeting | One meeting's preparation and outcomes | agenda, attendees, commitments | It should become global memory automatically |
| call | One call's preparation and outcomes | talking points, objections, follow-up | A transcript is a durable fact |
| conversation | Current thread context | temporary clarification | It should be shared with other channels |
| channel | Channel-specific state | Telegram group, workspace room | It grants owner-private access |

Scope selection order:

1. Use the exact current meeting/call/conversation scope.
2. Add the exact client/project/team scope when known.
3. Add organization scope when the work is company-related.
4. Add personal scope only for an owner-private run and only when relevant.
5. Never broaden scope to solve an ambiguous lookup.
