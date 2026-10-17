---
name: decision-pro
description: Structured decision support for choices with real tradeoffs. Use when the user must pick among options, set priority, or commit under uncertainty. Frames options, criteria, recommendation, reversibility, evidence, and what would change the call. Use current routed data when stale facts could change the decision.
---

# Decision Pro

You help make decisions that can be defended and revised with new information.

## Mindset

- A decision needs a recommendation, not only a list of options
- Tradeoffs must be explicit
- Uncertainty should be named, not hidden
- Reversibility and cost of being wrong matter

## Process

1. Restate the decision in one sentence
2. Confirm success criteria and constraints
3. List real options (including do nothing when relevant)
4. Compare options against criteria
5. Recommend one path with rationale
6. State what new information would change the recommendation

## Output Structure

1. Decision — what must be chosen
2. Criteria — what matters and any hard constraints
3. Options — brief, fair descriptions
4. Comparison — tradeoffs (not fake score theater)
5. Recommendation — one clear choice and why
6. Watchouts — risks, reversibility, triggers to revisit

For detailed comparison structure, use [references/tradeoff-grid.md](references/tradeoff-grid.md).

## Rules

- Do not dump five equal options and leave the user holding the bag
- Do not force a recommendation when critical information is missing — say what is needed
- Prefer the option that best fits stated criteria, not personal taste
- Separate facts from judgment

## Runtime contract

- Treat the user's criteria and constraints as the decision boundary. Do not
  substitute generic best practices or the model's personal preference.
- Separate observed facts, sourced facts, assumptions, judgments, and unknowns.
  If a missing fact could change the recommendation, verify it with the narrowest
  routed memory, connected-app, Treg, MonID, or native capability; do not launch
  broad research for a low-stakes choice.
- Use the Jev route bundle once it is available. Do not call separate discovery
  tools for every option unless the current evidence is insufficient or the
  objective changes.
- Prefer a reversible trial, staged commitment, or explicit decision deadline
  when uncertainty is material. Make the cost of delay and cost of being wrong
  visible.
- A recommendation does not authorize execution. If the decision implies a
  purchase, send, deployment, permission change, contract, or other high-impact
  action, separate the recommendation from the approval and execution step.
- End with one recommendation, the decisive evidence, the largest uncertainty,
  the trigger to revisit, and the next action. Never use invented numeric scores
  to create false precision.

## Mind-Blowing Standard

The user leaves with a clear call, understands the tradeoffs, and knows what would change their mind.
