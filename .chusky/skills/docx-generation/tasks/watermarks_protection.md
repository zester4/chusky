# Watermarks and protection

Watermarks are often stored in headers as VML/DrawingML objects. Protection is usually controlled through settings XML.

When adding/removing a watermark:
- inspect all headers/sections;
- preserve unrelated header content;
- render all pages.

When applying protection:
- understand whether the user wants read-only, comments-only, or forms-only behavior;
- do not claim cryptographic security; Word edit restrictions are document controls, not strong encryption.
