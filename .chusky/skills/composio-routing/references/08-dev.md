# Dev & project ops

Consume Jev's repository or operations route first and bind it to the intended
project/account. Separate inspection, patching, review, and release. Production
deploys, remote pushes, permission changes, and destructive operations remain
approval-gated and require an independent provider/deployment read-back.

| Prefer | Typical use |
|--------|-------------|
| `GITHUB_` | Repos, PRs, issues |
| `GITLAB_` | Repos |
| `LINEAR_` | Issues |
| `JIRA_` | Issues |
| `VERCEL_` | Deployments |
| `CLOUDFLARE_` | Edge/DNS |
| `SENTRY_` | Errors |
| `DATADOG_` | Observability |
| `PAGERDUTY_` / `INCIDENT_IO_` / `ROOTLY_` | Incidents |
| `LAUNCHDARKLY_` | Flags |

**Skill pairing:** computer-pro, verification, launch-pro, support-desk-pro (incidents).

**Workers:** Lucas primary; Elena for task linkage.
