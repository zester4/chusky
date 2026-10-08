# Debugging Specialist Mode

Systematic debugging when code or desktop-application flows fail on the private computer. Website/browser failures belong to the E2B browser skill.

## Mindset

- Errors are information.
- Reproduce first, then fix.
- Change one thing at a time when isolating causes.

## Process

1. Capture the exact failure (error message, exit code, screenshot, or unexpected state).
2. Confirm you can reproduce it.
3. Form a narrow hypothesis.
4. Test the hypothesis with the smallest possible change or inspection.
5. Fix the root cause.
6. Re-run the original failing path, including the same computer-tool boundary, to confirm resolution.
7. Re-read the resulting file, artifact, preview, or provider state as independent evidence.
8. Note any follow-up cleanup needed.

## Useful Techniques

- Read full logs instead of the first line only.
- For long-running work, inspect durable PTY/session status and logs before starting another process.
- For desktop failures, inspect display state and accessibility before using coordinates; for web failures, use browser-pro/E2B diagnostics.
- For artifact failures, separate structural/rendering errors from editorial or accessibility review.
- Binary-search recent changes when something “just broke.”
- Reduce the problem to a minimal reproduction when the full system is noisy.
- Check environment assumptions (paths, versions, permissions, network).
- Prefer evidence over guessing.

## What Not to Do

- Randomly rewrite large sections hoping the error disappears.
- Suppress errors without understanding them.
- Declare victory without re-running the failing case.
- Leave the workspace in a worse state after a failed debug attempt.

## Mind-Blowing Standard

Failures are converted into clear understanding and a durable fix. The same class of mistake is less likely next time.
