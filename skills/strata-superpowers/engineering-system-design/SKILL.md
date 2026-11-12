---
name: engineering-system-design
description: "Use for a new feature, application, service, or behavior change whose requirements or design need clarification."
---

# Design a testable behavior

Use this when the desired behavior is unclear or the change crosses important boundaries. A precise small request may already be enough design.

1. Read the user's request, project rules, and relevant existing code. Identify the user, concrete scenario, success criteria, and constraints. Do not ask for facts already available.
2. Separate requirements from assumptions. Ask one focused question only when an answer changes the main flow, data safety, or external contract. Continue independent work while waiting. Decide minor details yourself and label them as choices.
3. Compare two or three practical approaches when the trade-off matters. Include the current design. Choose the simplest approach that meets the requirements; use `engineering-architecture` for a specific architectural decision.
4. Describe the intended flow with an example: inputs, outputs, component boundaries, data ownership, errors, retries, cancellation, and acceptance checks. For a small change, a few sentences are enough.

For a system-level design, also cover authorization, concurrency, resource limits, persistence, recovery, compatibility, and migration where they matter. A queue ID alone is not an exactly-once guarantee; account for lost responses and duplicate effects.

If implementation was requested and the material decisions are known, continue to `writing-plans` or directly to the edit. If only design was requested, stop after presenting it. Do not turn design into deployment without authorization. Save a substantial design where the project normally keeps such documents; otherwise use `docs/superpowers/specs/YYYY-MM-DD-topic.md` when a file is useful.
