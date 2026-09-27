# Lifecycle: Lead → Customer → Relationship

Run the full commercial loop, not a one-shot enrich.

## Stages

```text
Discover → Enrich → Qualify → Capture (CRM/Sheet)
  → First touch → Converse → Meeting
  → Opportunity → Won (customer)
  → Onboard / expand / retain (relationship)
```

Update the system of record at **every** stage change.

## Stage playbooks

### 1. Discover & enrich
- Build or accept target list  
- Treg: company then people  
- Tier A/B/C/DQ with reasons  

### 2. Capture
- Composio: upsert account + contact  
- Status = `enriched` or `qualified`  
- Store sources and tier  

### 3. First touch
- Draft in owner voice (memory)  
- Personalize with real enrichment + trigger  
- On send (if allowed): status = `contacted`, log date  
- Set reminder for follow-up (native reminder / task)  

### 4. Converse
- Inbound reply on connected email → classify intent  
- Update notes in CRM/Notion  
- Status = `replied`  
- Escalate to human when negotiation or legal appears (deal-closer-pro)  

### 5. Meeting
- Book via calendar tools when connected  
- Load meeting-pro for live calls  
- After: notes + next steps in CRM  
- Status = `meeting`  

### 6. Opportunity
- Create deal/opportunity only when mutual seriousness exists  
- Amount/stage per owner process  
- Status = `opportunity`  

### 7. Won → customer
- Status = `won` / customer  
- Hand off: CS note, Slack #wins, onboarding checklist if they use one  
- Stop “cold outbound” tone; switch to customer success language  

### 8. Long-term relationship
- Periodic Treg refresh on account (new stakeholders, size, triggers)  
- Expansion contacts into CRM  
- QBR or check-in reminders  
- Status may move to `expand` or stay customer with open tasks  

## Cadence defaults (adjust to owner)

| Stage | Follow-up |
|-------|-----------|
| Contacted, no reply | 3–5 business days, then step-down |
| Replied, soft | Same week |
| Meeting done, no decision | Agreed date from the call |
| Customer | Quarterly intel refresh optional |

Use **CHUCK_SET_REMINDER** or tasks so the loop survives beyond one chat.

## Mission shape: “Work this segment until we have customers”

```text
Objective: Qualify and progress segment X
Checkpoints:
  - N accounts enriched
  - A-tier saved to CRM
  - Drafts approved / sent per policy
  - Meetings booked
  - Opportunities / wins logged
Evidence: CRM IDs, sheet links, message IDs, Treg receipts
```

## What “done” is not

- A chat list with no system of record  
- Enriched contacts never contacted  
- Sent email with no CRM update  
- Won deal with no handoff note  

## Mind-blowing standard

A stranger on a list becomes a **tracked relationship**: right system, right stage,
right next step, owner always able to see status without re-asking the agent.
