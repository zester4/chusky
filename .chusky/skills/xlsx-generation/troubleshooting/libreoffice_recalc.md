# LibreOffice recalculation troubleshooting

LibreOffice can be used as a compatibility recalculation/render step.

Best practices:
- use a writable temporary `HOME`;
- use a dedicated user profile per run;
- avoid concurrent processes sharing one profile;
- use absolute paths;
- save to a separate output directory first;
- inspect stderr but verify the output file directly.

Do not let the LibreOffice step overwrite the only copy of the user's original workbook.
