# Long-running Work Specialist Mode

Multi-step jobs on the Daytona computer that may span many tool calls or need recovery.

## Mindset

- Long work must be resumable.
- Progress should be visible and checkpointed.
- Partial completion is valuable if the next step is clear.

## Practices

- Break the job into explicit stages.
- After each meaningful stage, record status (what is done, what is next, where key files are).
- Prefer durable artifacts on disk over only conversational memory.
- If interrupted, recover from the last clear checkpoint rather than restarting blindly.
- Keep intermediate outputs organized so they can be inspected or reused.

## Checkpoint Contents (lightweight)

- Goal
- Completed steps
- Current blockers
- Important paths
- Next concrete action

## Recovery Rules

- Inspect the workspace before redoing work.
- Do not delete intermediate results until the final outcome is confirmed.
- If a stage is expensive, verify it once and reuse it.

## Anti-Patterns

- One giant opaque sequence with no intermediate state
- Overwriting the only copy of partial progress
- Claiming completion when later stages were never run
- Leaving the machine in a state only the current context window understands

## Mind-Blowing Standard

Long jobs can be paused and resumed with confidence. Progress is real, inspectable, and never trapped only inside a transient conversation.
