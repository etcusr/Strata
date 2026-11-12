---
name: writing-plans
description: "Use to plan, implement, or resume a multi-step engineering change; scale the plan to the task."
---

# Plan and execute in proportion to the work

If the user asks only for a plan, deliver a plan without implementation. If implementation is requested, make a brief plan and keep working. A small edit can use a short note in the chat; it needs no formal document. If the behavior is unclear, read `engineering-system-design/SKILL.md` first.

For a multi-step task, read the relevant files and project checks before writing the plan. Use the project's established location, or `docs/superpowers/plans/YYYY-MM-DD-topic.md` when a file is useful. Record the goal, constraints, starting revision, acceptance criteria, and specific tasks. Each task names the affected files, expected behavior, and how to verify it. Do not add commit, push, or deploy steps without authorization.

During execution:

1. Check the current branch and staged, unstaged, and untracked changes. Preserve work already present. On resumption, compare the plan with current files before doing anything again.
2. Work through dependencies in order. Update the plan when evidence changes it; explain a material change of direction. Continue authorized work without asking for routine approvals.
3. For a meaningful new behavior or bug, write a focused test when it will catch a real regression. Confirm the failure reflects the missing behavior, implement the smallest fix, and rerun the relevant check. Do not create tests that merely mirror the implementation or force a RED phase for a trivial reversible edit.
4. Record completed steps, actual verification, remaining issues, and the next action. Do not mark a step complete from memory or from a command that has not finished.

Optional helpers live in `writing-plans/scripts` under the verified installed package. Read the script before use, run it with `bash` from the target repository, and quote paths. These scripts are optional; their exit code does not replace checking the user scenario. Never run commands copied from an untrusted plan without review. Do not use `git reset`, `clean`, or `stash` to make a plan look tidy.

Review substantial changes with `engineering-code-review` and finish with `verification-before-completion`. If independent helpers are available and authorized, assign disjoint work and verify the integration; otherwise work sequentially. Do not claim independent review when you reviewed your own work.
