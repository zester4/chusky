---
name: skill-creator
description: Guide for creating and updating skills that extend the agent's capabilities. Use when a user wants to create a new skill, update an existing skill, or asks about the skill format. Triggers include "create a skill", "make a skill for", "new skill", "update this skill", "skill format".
---

# Skill Creator

This skill helps you design, write, test, and maintain high-quality agent skills.

## Skill format overview

A skill is a directory containing at minimum a `SKILL.md` file with YAML frontmatter:

```yaml
---
name: my-skill
description: Clear one-sentence description of when to use this skill and what it does.
---

# My Skill

Detailed instructions...
```

Optional companions: reference docs, scripts, templates, examples.

## Best practices for good skills

1. **Narrow scope** — One clear job per skill. Reliability drops when a skill tries to do too many things.
2. **Strong description** — The description is routing logic for the model. Make it specific about triggers and use cases.
3. **Progressive disclosure** — Put high-signal gotchas and critical rules early. Keep the body focused.
4. **Gotchas section** — Explicitly document failure modes and anti-patterns.
5. **Deterministic scripts** — For fragile or precise steps, prefer scripts over pure LLM generation.
6. **Test cases** — Include realistic evaluation scenarios.

## Workflow for creating a new skill

1. Clarify the exact capability needed
2. Draft the YAML frontmatter + outline
3. Write the core instructions
4. Add gotchas and edge cases
5. Optionally add scripts / references
6. Test with the agent (with and without the skill)
7. Iterate based on results

## Updating an existing skill

- Keep the name stable unless there is a strong reason to change it
- Expand the description carefully (it affects routing)
- Prefer additive changes over rewrites when the skill is already in use
