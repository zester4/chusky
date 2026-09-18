# OOXML: content controls

Content controls use `<w:sdt>` with `<w:sdtPr>` and `<w:sdtContent>`.

Useful metadata includes:
- `<w:tag>`;
- `<w:alias>`;
- placeholder/showing-placeholder flags;
- data bindings.

When filling a control, preserve its properties and replace only the intended content unless the user asks to unwrap/remove the control.
