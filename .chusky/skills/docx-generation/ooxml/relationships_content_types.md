# OOXML: relationships and content types

When adding new parts:
- update the correct `.rels` file;
- use unique relationship IDs;
- add content-type overrides/defaults when required;
- keep paths relative to the owning part;
- avoid dangling relationships.

Use ZIP/XML tools to validate the package after patching.
