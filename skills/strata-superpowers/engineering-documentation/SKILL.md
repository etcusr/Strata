---
name: engineering-documentation
description: "Use for README, API documentation, runbooks, setup instructions, or a handoff note."
---

# Document what works today

Identify the reader and the task they need to complete. Read existing docs, relevant code and configuration, and command help. Match the project's terminology and location. A narrow correction can be made in place without a formal plan.

Include only the fields the document needs: a README needs prerequisites and a minimal working start; an API guide needs request and error contracts; a runbook needs symptom, diagnosis, stop conditions, recovery, and verification; a handoff needs current files, completed work, checks, blockers, and next step.

Separate implemented behavior from proposals. For commands, specify the platform, working directory, prerequisites, replaceable values, and expected result. Do not include secrets. Verify links, paths, syntax, and safe examples; state which examples were not run. A running process does not by itself prove an API is healthy, and an untested backup does not prove recovery.

Check the document against the code before reporting completion. Do not run destructive production steps merely to illustrate an instruction. A simple prose edit does not need a unit test.
