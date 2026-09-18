# LibreOffice headless troubleshooting

Common fixes:
- set a writable `HOME`;
- use a dedicated LibreOffice user profile per run;
- avoid concurrent processes sharing one profile;
- ensure the input file is not locked;
- capture stdout/stderr;
- use absolute paths;
- verify the generated PDF exists and is non-empty.

Some stderr warnings are non-fatal. Trust the existence and visual quality of rendered pages, not stderr alone.
