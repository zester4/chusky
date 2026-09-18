# Formula error triage

Scan for:
- `#REF!`
- `#DIV/0!`
- `#VALUE!`
- `#NAME?`
- unexpected `#N/A`

Then inspect the exact formulas in the surrounding region.

Common root causes:
- mismatched row ranges;
- deleted sheets;
- text where numbers are expected;
- unsupported functions;
- broken named ranges;
- formulas copied with the wrong absolute/relative references.

Fix the model, then re-run the scan.
