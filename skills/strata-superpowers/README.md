# Strata Superpowers

One importable Strata skill with ten supporting procedures and five optional shell scripts. The main skill selects a procedure only when the task needs it. It does not run an entire engineering workflow for a greeting or a simple answer.

## Install

1. Unpack `strata-superpowers.zip` if you received an archive.
2. In Strata, open **Skills → Add skill**.
3. Select the folder that directly contains this package's main `SKILL.md` and `strata-superpowers.json`.

Select the folder, not the ZIP or a nested procedure. Strata imports the supporting files with it. An existing skill with the same identity may need to be replaced through Strata's skill management before reimporting; importing the same folder again is not an update operation.

If old engineering or browser skills were installed separately, review their enabled state to avoid overlapping instructions. This package does not change those settings.

## Included procedures

- System design and architecture decisions
- Proportional planning and implementation
- Reproducible and intermittent debugging
- Code review and review feedback
- Documentation and handoff
- Verification before claiming completion
- Browser inspection and web fetch fallback
- Security audit when explicitly requested

The procedures are written in English. They direct Strata to answer in the user's language; for Russian, use clear natural Russian while preserving exact command and file names. File discovery uses `rg --files` and `rg` when available. The main skill reads only the supporting procedure needed for the current stage.

## Requirements and limits

Importing the package needs no npm or pip dependencies. The optional helpers in `writing-plans/scripts` use Bash, Git, and standard command-line utilities. Strata must already have the relevant tool enabled. The skill does not install tools, start a browser, change permissions, or create a helper agent by itself.

The main skill may be mirrored into Strata's `skills-live` directory without its supporting files. It locates the imported package in the active workspace's `skills` folder and avoids scanning the whole home directory. If the package is inaccessible, the agent uses the main guidance and reports the missing resource only if it affects the task.

Browser procedures require an enabled browser tool. They use the tool names actually available, verify page content, and close only tabs or sessions the task owns. The optional scripts do not commit, push, deploy, discard working changes, or control a browser.

## Optional scripts

- `sdd-workspace`: directory for one plan's execution notes.
- `task-brief`: extract one `### Task N: ...` section.
- `task-start`: show the task and starting Git revision.
- `task-done`: run the chosen check and record its exit status.
- `review-package`: collect a committed revision range for review; inspect uncommitted files separately.

Read a script before running it. A zero exit status is not proof that the user's full requirement was met. See `NOTICE.md` and `writing-plans/scripts/LICENSE.superpowers` for provenance and license terms.
