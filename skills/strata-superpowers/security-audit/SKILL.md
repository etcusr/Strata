---
name: security-audit
title: "Security audit"
description: "Use only when the user explicitly requests a security review of code, a repository, or a change."
---

# Find demonstrable security defects

Establish the repository, revision, components, and scope. Identify what an attacker controls and the assets at risk. Start with source reading and safe local checks. Do not test third-party systems or change production data without a specific request.

Trace data from an entry point through parsing, validation, authorization, and use. Check relevant paths for access control mistakes, injection, unsafe file access, secret handling, races, resource exhaustion, and protocol-specific invariants. Use `rg --files` to locate code and `rg` for targeted searches; a keyword match alone is not a vulnerability.

For each candidate, inspect callers, guards, configuration, and tests. Confirm an attacker can reach the path and that the claimed consequence follows. Reproduce safely where possible. Separate an unconfirmed hypothesis from a confirmed finding; do not invent a CVE, exploit result, or line number.

Report confirmed findings first, in risk order. Each finding needs a precise location, attack preconditions, controlled input, execution path, impact, and concrete repair with a regression check. Then list remaining hypotheses, the code reviewed, tests run, and limits. If no finding is confirmed, say that without claiming the entire project is secure.
