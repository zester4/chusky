# Tracked changes / redlines

Tracked changes use WordprocessingML elements such as `<w:ins>` and `<w:del>`.

Guidelines:
- preserve authorship/date metadata intentionally;
- do not confuse visual strike-through with a real deletion;
- use real tracked changes when the user asks for a redline;
- provide a clean accepted copy only when requested;
- re-render after accepting/rejecting changes.

Use `scripts/accept_tracked_changes.py` for finalization. Advanced generation should follow `ooxml/tracked_changes.md`.
