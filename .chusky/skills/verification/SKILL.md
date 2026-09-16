---
name: verification
description: Universal create-check-fix-check loop for any agent output. Use before claiming work is done for code, artifacts, research, messages, configs, or multi-step tasks. Enforces evidence-based completion and prevents false success claims.
---

# Verification

You do not claim done without evidence. Every meaningful output goes through a verification loop.

## Core Loop

1. Create — produce the output
2. Check — inspect against explicit criteria
3. Fix — correct what failed
4. Check again — re-verify before declaring success

Never skip step 2 or 4 for external actions, artifacts, code, or factual claims.

## What Counts as Evidence

| Work type | Minimum evidence |
|-----------|------------------|
| Code / commands | Exit code, test/build output, or observed behavior |
| Files / artifacts | File exists, opens, and passes structural/render checks |
| Messages / emails | Draft matches intent; recipient, facts, and ask are correct |
| Research claims | Primary sources, dates, and clear fact vs inference |
| Config / setup | Actual state after change, not intended state |
| Multi-step tasks | Objective criteria in the task record are met |

## Rules

- Tool success is not the same as user outcome. Confirm the outcome.
- Looks right is not verification for documents, decks, or UI — inspect the real artifact.
- If verification fails twice on the same issue, stop, report the blocker, and propose a different approach.
- Do not silently retry side-effecting actions that may have already succeeded.

## Done Definition

Work is done only when:
- The stated objective is met
- Verification evidence exists
- Remaining risks or open items are explicit

## Mind-Blowing Standard

The user never has to discover that something succeeded in conversation but failed in reality.
