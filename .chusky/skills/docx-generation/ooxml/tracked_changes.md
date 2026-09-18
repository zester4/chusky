# OOXML: tracked changes

Tracked insertions use `<w:ins>` containing runs; deletions use `<w:del>` and deleted text typically uses `<w:delText>`.

Important:
- use unique revision IDs;
- include `w:author` and `w:date` when appropriate;
- preserve run properties where possible;
- do not place invalid nested revision elements;
- accept/reject changes by transforming the XML, not by styling text.

After patching, ensure the DOCX remains a valid ZIP package and render it.
