import type { SkillBinding } from "../skills/catalog.js";
import type { CapabilityWorkerName } from "../memory/types.js";

/** Deterministic skill preload map per specialist. */
export const WORKER_SKILL_BINDINGS: Record<CapabilityWorkerName, SkillBinding> = {
  lucas: {
      primary: ["fullstack-dev", "computer-pro"],
      supporting: ["senior-fullstack", "codebase-design", "code-review", "tdd", "verification", "handoff", "fullstack-guardian"],
      requiredReferences: {
        "fullstack-dev": ["references/testing-strategy.md", "references/release-checklist.md"],
        "computer-pro": ["references/01-workspace-hygiene.md"],
      },
    },
  maya: {
      primary: ["writing-pro", "workspace-pro"],
      supporting: ["content-strategy", "cold-email", "seo-audit", "lead-magnets", "marketing-ideas", "verification"],
      requiredReferences: {
        "workspace-pro": ["references/08-triage-decision.md", "references/10-voice-and-style.md"],
      },
    },
  leo: {
      primary: ["writing-pro", "imagine", "video-editing"],
      supporting: ["marketing-ideas", "marketing-psychology", "media", "content-strategy", "frontend-design"],
    },
  sofia: {
      primary: ["voice-call-pro"],
      supporting: ["workspace-pro", "meeting-pro", "verification", "decision-pro", "billing-ops-pro"],
      requiredReferences: {
        "voice-call-pro": ["references/03-lead-qualification.md", "references/04-appointment-booking.md", "references/05-follow-up.md"],
      },
    },
  dexter: {
      primary: ["computer-pro"],
      supporting: ["agent-browser", "browser-pro", "verification", "handoff"],
      requiredReferences: {
        "computer-pro": ["references/03-browser-automation.md", "references/05-tickets-qa.md"],
      },
    },
  elena: {
      primary: ["attention-pulse", "project-pro"],
      supporting: ["workspace-pro", "handoff", "verification", "decision-pro"],
      requiredReferences: {
        "attention-pulse": ["references/07-handle-and-delegate.md"],
        "project-pro": ["references/status-update.md"],
        "workspace-pro": ["references/07-reminders-recurring.md"],
        "handoff": ["references/packet.md"],
      },
    },
  nora: {
      primary: ["research-pro"],
      supporting: ["customer-research", "workspace-pro", "verification", "grill-me", "decision-pro"],
      requiredReferences: {
        "research-pro": ["references/brief-template.md"],
        "verification": ["references/evidence-checklist.md"],
      },
    },
  ivy: {
      primary: ["workspace-pro", "writing-pro"],
      supporting: ["support-desk-pro", "cold-email", "triage", "verification", "project-pro"],
      requiredReferences: {
        "support-desk-pro": ["references/01-triage.md", "references/02-replies.md", "references/03-escalation.md"],
        "workspace-pro": ["references/01-email-inbound.md", "references/02-email-drafting.md", "references/08-triage-decision.md"],
        "project-pro": ["references/status-update.md"],
      },
    },
  quinn: {
      primary: ["customer-research", "decision-pro", "meeting-pro"],
      supporting: ["expansion-pro", "billing-ops-pro", "launch-pro", "workspace-pro", "writing-pro", "verification"],
      requiredReferences: {
        "expansion-pro": ["references/01-readiness.md", "references/02-plays.md", "references/04-handoffs.md"],
        "billing-ops-pro": ["references/01-invoices.md", "references/02-dunning.md"],
        "customer-research": ["references/source-guides.md"],
        "meeting-pro": ["references/03-deal.md", "references/09-discovery.md", "references/10-negotiation.md"],
        "workspace-pro": ["references/03-calendar.md"],
      },
    },
  aria: {
      primary: ["meeting-pro", "onboarding-pro", "retention-pro"],
      supporting: ["customer-research", "support-desk-pro", "workspace-pro", "project-pro", "verification"],
      requiredReferences: {
        "onboarding-pro": ["references/01-client-onboarding.md", "references/04-milestones.md", "references/06-risks.md"],
        "retention-pro": ["references/01-health.md", "references/02-churn-risk.md", "references/04-renewals.md"],
        "meeting-pro": ["references/04-onboarding.md", "references/12-customer-success.md"],
        "workspace-pro": ["references/08-triage-decision.md", "references/07-reminders-recurring.md"],
        "project-pro": ["references/status-update.md"],
      },
    },
  kai: {
      primary: ["research-pro", "workspace-pro"],
      supporting: ["verification", "decision-pro", "xlsx", "grill-me"],
      requiredReferences: {
        "research-pro": ["references/brief-template.md"],
        "workspace-pro": ["references/06-spreadsheets-data.md", "references/07-reminders-recurring.md"],
        "verification": ["references/evidence-checklist.md"],
      },
    },
};
