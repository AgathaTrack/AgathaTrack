---
name: review-agent
description: Reviewer for the issue pipeline "In analysis" stage — review one version of an issue body against the code. Either edit it yourself (the edit is your approval; post no verdict after it) or record a signed review verdict with scripts/pipeline_verdict.js. Reactions are never votes. Use when an issue at Stage "In analysis" has a "Review requested for <hash>" comment assigned to you. Spec lives in the pipeline v2 tracking issue (#2385).
disable-model-invocation: true
---

# Review agent (In analysis)

You were asked to review **one version** of an issue body, identified by the hash in the "Review requested for `<hash>`" comment. Spec: issue #2385 §In Analysis.

## Procedure

1. Read the issue with `node scripts/pipeline_verdict.js read`, its comments and the request comment. Run `node scripts/github_issue_workflow.js clear-queued --issue <n>` first when the issue still has `queued` from a runner cap (does not clear `busy`). Check the hash still matches the body you are reading; if the body changed, wait for the new request.
2. **Review against the code, not only the text.** Open the files, workflows and docs the issue names. Confirm the facts it states, the paths it plans to touch, and that its Definition of Done is testable (**delivery** items only — reject live board soak rows in DoD; defer via [soak-testing.md](../../../docs/agent-efficiency/soak-testing.md)). The delivery plan (method, planned work, `agent-paths`, Definition of Done) is part of what you approve.
3. **Either edit or vote, never both.**
   - **Edit** when you can fix what is wrong yourself: `node scripts/pipeline_verdict.js edit --from <hash> --file <path>`. The edit is your approval of the new version. It closes your round, another run reviews the new hash, and you post **no verdict** for it. Say what changed in one comment. **Do not** edit to evade launch safety: never reword **Security or Sensitive Area**, titles, or scope text to hide work that still needs AGENTS.md §Escalation (soak2 #2495). Use **`Blocked=decision`** and keep the body truthful (PIPE-V2-D-SOAK-008).
   - **Verdict** when the version is sound as written, or when it is not and you did not edit: `node scripts/pipeline_verdict.js review up --hash <hash>` or `review down --hash <hash>`. A down names the concrete change you want, in a normal comment.
4. Write your reasoning as **one comment**, before any verdict: what you checked, what you changed, what remains. Evidence goes on the issue, not only in chat.
5. Post at most one verdict, as your last action. It reveals your run nonce, which the CLI reads from `PIPELINE_RUN_NONCE`; never type or print it.

## Rules

- **Only signed verdicts count.** A 👍, a 👎 or any other reaction is never a vote, from you or from anyone else, the owner included.
- Never post a verdict on a version you edited. The edit is your approval; a verdict after it is ignored by the engine.
- Never write `Stage` (the engine does, or the owner during bootstrap). You may edit the body, post a verdict and write `Blocked`.
- Hit an item on the AGENTS.md escalation list (security, breaking API, production migration, CI gate, product or legal call)? Set `Blocked=decision` with your recommendation instead of a verdict. Preserve current `Stage` and `Attempts` in the same org-field patch, then run `node scripts/github_issue_workflow.js finish-work --issue <n>`.
- Do not reword scope to hide an escalation item. If the plan needs AGENTS.md §Escalation, set `Blocked=decision` and keep the body truthful (PIPE-V2-D-SOAK-008).
- After 6 signed verdicts and agent edits without convergence the engine blocks the issue for the owner (`no-convergence`), so prefer fixing over bouncing.
