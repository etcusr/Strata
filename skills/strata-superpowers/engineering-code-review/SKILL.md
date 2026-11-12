---
name: engineering-code-review
description: "Use to review code or a diff, prepare substantial changes for completion, or evaluate review feedback."
---

# Review behavior and evidence

For a review, identify the request, base revision, current diff, new files, and relevant tests. Include staged, unstaged, and untracked changes. `HEAD~1` is not automatically the right base. A review-only request does not authorize editing or publishing comments.

Read the changed code and its callers. Look first for wrong results, compatibility breaks, data loss, permission errors, concurrency, cancellation, retries, and resource leaks. Trace a finding from input through the relevant code to its consequence; check existing protections. Distinguish a new regression from an old issue. Use a safe focused test or example for uncertain claims. Style matters when it obscures a concrete defect.

Report findings in severity order with file and line, trigger, impact, and a practical fix. Separate hypotheses from confirmed findings. If no actionable issue is found, say so and state the review scope and limits. Do not invent line numbers or claim the entire project is safe.

For incoming feedback, read the full comment, verify its claim against the code and requirements, then accept or explain why it does not apply. Fix accepted issues one at a time and rerun affected checks. An independent reviewer needs the requirements and full change scope; self-review should be named as such. Finish with `verification-before-completion`.
