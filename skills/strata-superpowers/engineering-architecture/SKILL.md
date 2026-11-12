---
name: engineering-architecture
description: "Use for a specific architecture or technology choice, comparison of trade-offs, or an architecture decision record."
---

# Make an architecture choice

1. State the decision and its scope. Read the relevant code, existing decisions, and constraints: compatibility, data safety, latency, operations, and cost.
2. Separate verified facts from assumptions. Test an unknown if it could change the decision. Verify changing details such as versions, licenses, and prices from primary sources when available.
3. Compare the current design with realistic alternatives using the same criteria. Include failure modes and migration effort. Do not invent numeric scores or claim a benchmark applies to a different workload.
4. Choose the smallest sufficient option. Explain its main trade-off, what would make you revisit it, and any hard-to-reverse consequence. Check one normal flow and one important failure.

For an ADR, write status, date, context, criteria, options, decision, consequences, validation, and revision trigger. New records start as Proposed unless acceptance was actually delegated or confirmed. A small choice can stay in the chat; it does not need an ADR file.

Pass the resulting contract to implementation. Choosing a technology does not itself authorize a production migration.
