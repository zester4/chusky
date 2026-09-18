# Redaction and anonymization

DOCX redaction should remove or replace sensitive content from the document model.

Do not merely add black highlighting or shapes.

Workflow:
1. identify sensitive text/metadata;
2. replace/remove it in paragraphs, tables, headers/footers, comments, and other relevant parts;
3. scrub metadata if needed;
4. verify extracted XML/text no longer contains the sensitive value;
5. render and inspect.

Use `scripts/redact_docx.py` for basic text-pattern redaction.
