---
name: strata-superpowers
description: "Use for substantial engineering work: design, implementation, debugging, review, verification, documentation, and browser diagnosis. Skip for greetings and simple factual questions."
---

# Strata Superpowers

Use one relevant procedure at a time. User instructions and project rules take priority. A routine answer or small reversible edit does not need a full planning workflow.

## Find the installed package once

This main skill may be mirrored into `skills-live` without its supporting files. Locate the actual imported `skills/strata-superpowers` folder in the active Strata workspace. Check the workspace named in `STRATA_WORKSPACE`, then the configured workspace's `skills` folder, then `~/Documents/Strata/Workspace/skills`. Verify `strata-superpowers.json` and the needed nested `SKILL.md`. Use `rg --files` within those folders when useful. Do not scan the whole home directory, search Downloads, install dependencies, or repeat this search after finding the package. If supporting files are inaccessible, apply the guidance here and state that limit only when it affects the result.

## Select a procedure

| Work | Read only this file when needed |
|---|---|
| Feature or unclear product behavior | `engineering-system-design/SKILL.md` |
| Architecture choice | `engineering-architecture/SKILL.md` |
| Multi-step implementation or resumption | `writing-plans/SKILL.md` |
| Reproducible defect | `engineering-debug/SKILL.md` |
| Intermittent or repeated defect | `systematic-debugging/SKILL.md` |
| Code review or review feedback | `engineering-code-review/SKILL.md` |
| README, API guide, runbook, handoff | `engineering-documentation/SKILL.md` |
| Before claiming completion | `verification-before-completion/SKILL.md` |
| Interactive website or failed page fetch | `browser-interaction/SKILL.md` |
| Explicit security audit | `security-audit/SKILL.md` |

Read a supporting file when its stage arrives, not all of them at the start. Do not reread an unchanged file in the same task. Nested files are package resources, not separate registered Strata skills.

## Working habits

- Understand the request and inspect the relevant files before editing. Search filenames with `rg --files` and content with `rg`; use bounded output. If `rg` is unavailable, use the platform's available file tools.
- Use a short plan proportional to the work. Continue authorized implementation without asking at every step. Preserve existing user changes and verify the actual result.
- For a repeated failure, compare a failing trace with a working one and test one cause at a time. Do not retry identical failed tool calls in a loop.
- Report progress and results in the user's language. For Russian, use natural Russian with short concrete sentences; leave exact command, file, and product names intact. Avoid mixed-language filler and unexplained jargon.
- Never claim to have run a tool, test, browser, or helper unless it actually ran. Skills do not add permissions for external actions.

The optional `writing-plans/scripts` helpers belong to the installed package. Read `writing-plans/SKILL.md` before using them. They are not required for ordinary work.
