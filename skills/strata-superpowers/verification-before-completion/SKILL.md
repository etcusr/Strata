---
name: verification-before-completion
description: "Use before claiming that a change, build, test, service, import, or user scenario is complete or fixed."
---

# Verify the claim you intend to make

1. Match each important requirement to an observed result. Check that the evidence is from after the last relevant edit and in the correct environment.
2. Run only the checks needed for the remaining risk and any required project gate. Wait for completion, inspect exit status, failures, skips, and meaningful output. An old pass, a started command, or a zero-exit script that ran no tests does not prove success.
3. Inspect the final diff and new files. Verify the actual user scenario when possible; a PID or unit test may not prove the application works end to end. After review fixes, rerun affected checks.
4. State what was changed, what passed, what was not tested, and any remaining issue. Continue authorized fixes where possible. Do not describe an unverified result as complete.

Use safe copies for destructive reproduction. Do not reset user files to manufacture a failing test. A self-review and an independent review are different evidence. Stop optional testing once the relevant claim is sufficiently supported.
