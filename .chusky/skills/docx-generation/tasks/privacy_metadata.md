# Privacy and metadata

A DOCX can contain author/company metadata, revision IDs, comments, hidden text, tracked changes, custom properties, and embedded files.

When scrubbing:
- remove personal core/custom properties as requested;
- remove comments/tracked changes if the user wants a clean publishing copy;
- consider `rsid*` cleanup;
- verify relationships and embedded parts;
- save to a new file;
- inspect the resulting package.

Use `scripts/privacy_scrub.py`.
