---
name: systematic-debugging
description: "Use when a failure is intermittent, spans components, persists after a fix, or has no established cause."
---

# Observe, hypothesize, distinguish, verify

1. Preserve the failing conditions: version, input shape, timing, state, logs, and a stable request ID where available. Trace the path across components and locate the first boundary where the expected state changes. Record metadata instead of exposing secrets or full private content.
2. Find a comparable successful case. Compare its code path, configuration, state, call order, and dependencies.
3. Test one hypothesis at a time. State the predicted observation, an alternative explanation, the experiment, its time limit, and the stopping condition. Keep negative results; remove only your own temporary diagnostic changes.
4. Once localized, reproduce the defect safely, fix the cause, and repeat under comparable conditions. For flaky behavior, one passing run is weak evidence; choose repetitions based on the observed failure rate and state the remaining uncertainty.

For performance, compare matching inputs, model state, cold/warm cache, hardware load, and thermal state. For a lost response, inspect the operation's stable ID before resending it. After several failed fixes, revisit the model of the system instead of stacking more guesses.

Finish with a concrete finding, test evidence, and next experiment if unresolved. Use `engineering-code-review` for substantial changes and `verification-before-completion` before a success claim.
