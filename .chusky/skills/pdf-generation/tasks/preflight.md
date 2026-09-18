# PDF preflight

A minimum preflight should report:
- opens successfully;
- encrypted or not;
- page count;
- page dimensions;
- metadata;
- form presence;
- annotation/link count;
- suspicious zero-sized or extreme pages.

A stronger production gate also renders every page. Structural validity without successful rendering is not enough.

Fail closed on malformed files, missing pages, renderer crashes, or obvious truncation.
