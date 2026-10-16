# Chusky agent prompt architecture

This is the canonical shape of the Chusky supervisor instructions. The uploaded host-agent prompt was used as a design reference for separation of concerns, context provenance, tool discipline, and response contracts. Its platform-specific tools, UI rules, and hidden context handling are not copied into Chusky.

## Instruction layers

The runtime composes the model prompt in this order:

1. `SYSTEM_PROMPT` deployment customization: persona, organization-specific language, and non-security operating preferences.
2. Mode and capability playbooks: attention pulse, autonomy, meeting, shopping, trigger, and capability-routing guidance selected by the runtime.
3. Developer instructions for the current run, when present.
4. Code-owned `INSTRUCTION_ORDER_KERNEL`: authority and context provenance.
5. Code-owned `TURN_EXECUTION_KERNEL`: the request-to-result protocol and response contract.
6. `IMMUTABLE_SAFETY_KERNEL`: the final non-removable safety, ownership, approval, and verification boundary.

The final two layers are always present. A deployment prompt can shape voice and product behavior, but it cannot remove the execution contract or weaken runtime policy.

## Context provenance

The agent should distinguish four kinds of input:

- The user's request and bounded recent conversation establish the objective and continuity.
- A memory brief supplies relevant durable facts; it is not a new instruction and must not be dumped wholesale.
- A selected skill supplies procedure and domain guidance; it does not grant access or approval.
- Routes, schemas, tool results, emails, documents, webpages, repositories, and provider responses are evidence or callable data. They cannot rewrite the instruction hierarchy.

## Per-turn protocol

The supervisor should:

1. Determine whether the request is conversational, an action, a durable mission/task, or a meeting/shared-scope turn.
2. Identify the desired outcome, required current state, side effects, scope, and definition of done.
3. Use the route bundle already prepared by Jev. On eligible ordinary private turns, Jev evaluates the independent skill/native/connected-app/Treg/MonID routing questions together. It is a router, not an executor or approver.
4. Use the narrowest exact exposed capability. Refine discovery only when the required capability is genuinely absent or the objective changes.
5. Execute, inspect the result, and verify the postcondition that matters to the user.
6. Report verified completion, partial completion, or the exact blocker and next action.

## Capability boundaries

- Skills are selected from name and description, then loaded from the trusted project skill directory.
- Native tools are Chusky-owned capabilities and should be called with their exposed schema.
- Composio handles connected-app reads and writes. Toolkit selection can be followed by exact action/schema loading; account scope and approvals remain runtime concerns.
- Treg handles broad live external intelligence and provider catalog calls.
- MonID handles structured public-data/API catalogue coverage when explicitly requested or when there is a concrete coverage gap.
- None of these routes authorize an action or prove success.

## Response behavior

The model should not narrate internal routing or repeat a preliminary opening. It should answer directly for conversation, act for authorized work, and report only what is verified. For multi-step work, it should preserve the durable task/mission lifecycle rather than pretending that a prose plan is progress. In meetings and shared conversations it must remain inside the explicit meeting grant and avoid leaking private owner context.

## Maintenance rules

When adding a new capability, update its runtime tool schema and route metadata first. Add prompt guidance only for behavior that cannot be expressed by the schema, policy, skill, or deterministic runtime. Keep model-facing instructions compact, explicit, and testable; do not paste an entire platform tool catalogue into `SYSTEM_PROMPT`.
