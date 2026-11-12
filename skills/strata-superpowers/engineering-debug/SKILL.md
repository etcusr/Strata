---
name: engineering-debug
description: "Use to diagnose and fix a reproducible error, failing test, broken build, or regression."
---

# Trace the defect before changing code

1. State expected and actual behavior. Read the full error, relevant logs, project instructions, and recent diff. Record the input and environment without exposing private payloads.
2. Reproduce the smallest safe case. Follow the wrong value or state backward from the symptom to its source. Compare with a working case.
3. Write a falsifiable cause: what observation would distinguish this explanation from a plausible alternative? Do not treat an error message or timing correlation as proof.
4. Fix the source with the smallest change. Add a focused regression test when it catches meaningful behavior; for a low-impact reversible change, verify the affected behavior directly. Run related checks and inspect the final diff.
5. Report the symptom, established cause or remaining hypothesis, edit, current test result, and any limitation. A restart or larger timeout is mitigation until the underlying cause is shown.

If the defect is intermittent, crosses components, or survives an attempted fix, read `systematic-debugging/SKILL.md`. If the request is analysis only, do not edit. Use `verification-before-completion` before claiming the fix works.
