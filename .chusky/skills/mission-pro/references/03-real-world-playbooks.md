# Real-world mission playbooks

These map production-style agent work onto Chusky missions. Adapt steps to the owner’s tools and approvals.

## 1. Customer support resolution

**Objective:** Resolve ticket T with correct action or clean escalation.  
**Done when:** Customer notified, system state updated, evidence logged; or escalated with full context package.

Suggested steps:
1. Triage intent + urgency (Ivy / workspace-pro)
2. Pull CRM/order/history (Composio)
3. Resolve if policy allows OR draft + request approval if risky
4. Send reply in owner voice
5. Evidence: receipt + before/after status
6. Verify + complete

**Waits:** customer reply, provider webhook, human approval.

## 2. Sales / lead pipeline

**Objective:** Qualify lead L and either book next step or close-lost with reason.  
**Done when:** CRM updated, outreach sent (if authorized), next meeting or disposition recorded.

Steps:
1. Enrich company/contact (Nora + Composio)
2. Score vs ICP (decision-pro patterns)
3. Draft personalized outreach
4. Send if autonomous / approve if needed
5. `WAIT_EVENT` or reminder for reply window
6. Update CRM + evidence

## 3. Invoice / collections (AR)

**Objective:** Move overdue invoice I toward payment or documented escalation.  
**Done when:** Paid reconciled, or tiered follow-ups completed with escalation package.

Steps:
1. Confirm amount, due date, contact from source of truth
2. Tier-1 reminder (autonomous if policy allows)
3. Wait / re-check payment
4. Tier-2 firmer follow-up
5. Escalate high-value to owner with proof pack
6. Reconcile payment event → complete

**Never** threaten or invent legal claims. Money movement stays gated.

## 4. Employee / client onboarding

**Objective:** Complete onboarding checklist for person P by date D.  
**Done when:** All required items verified (accounts, docs, training) or blockers escalated.

Steps:
1. Build checklist from template + role
2. Provision / request access (approve when required)
3. Send welcome + tasks
4. Track completion; wait on external IT
5. Evidence each checkbox
6. Verify + complete or block with owner nextAction

## 5. Research → deliverable

**Objective:** Deliver verified report/PDF on topic X.  
**Done when:** Artifact registered, sources cited, owner can open the file.

Steps:
1. Scope questions + sources (Nora)
2. Research with COMPOSIO_SEARCH_WEB / allowed tools
3. Draft structured sections
4. `CHUCK_CREATE_PDF` or docx; expand content first if long
5. Register artifact only after file exists
6. Evidence + verify page/quality bar

## 6. IT / ops remediation

**Objective:** Clear incident or ticket with verified fix.  
**Done when:** Service healthy or rolled back; timeline + receipts stored.

Steps:
1. Reproduce / gather logs (Daytona / computer-pro as allowed)
2. Hypothesize + apply **safe** fix
3. Verify health check
4. Document before/after evidence
5. Production-risk steps require approval

## Life / personal variants

Same shapes: trip planning (research → shortlist → wait on confirm → book with approval), purchase comparison, document packages for visas/applications, “chase until done” with honest waits.

## Playbook rules

- Name the **system of record** (CRM, inbox, sheet, repo)
- Put **approval** only on irreversible steps
- Prefer **one mission per outcome**, not one mission per message
