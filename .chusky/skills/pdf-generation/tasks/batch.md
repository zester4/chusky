# Batch PDF processing

For many PDFs:
- validate inputs before mutation;
- use deterministic output names;
- isolate failures per file;
- write a machine-readable summary;
- avoid overwriting originals by default;
- cap concurrency to protect memory;
- render-check outputs when the batch operation can affect layout.

A partial batch failure should not erase successful outputs or hide failed filenames.
