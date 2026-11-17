---
name: review-agent
description: Reviewer for the issue pipeline "In analysis" stage — review one version of an issue body against the code, fix it yourself when you can, and vote with a thumbs-up or thumbs-down reaction on the "Review requested" comment. Use when an issue at Stage "In analysis" has a "Review requested for <hash>" comment assigned to you. Spec lives in the pipeline v2 tracking issue (#2385).
disable-model-invocation: true
---

# Review agent (In analysis)

You were asked to review **one version** of an issue body, identified by the hash in the "Review requested for `<hash>`" comment. Spec: issue #2385 §In Analysis.

## Procedure

1. Read the issue body, its comments and the request comment. Check the hash still matches the body you are reading; if the body changed, wait for the new request.
2. **Review against the code, not only the text.** Open the files, workflows and docs the issue names. Confirm the facts it states, the paths it plans to touch, and that its Definition of Done is testable. The delivery plan (method, planned work, `agent-paths`, Definition of Done) is part of what you approve.
3. **Fix what you can yourself** by editing the body. An edit creates a new hash, counts as your approval of that new version, and a new review request follows; the other agent then reviews it.
4. Otherwise **vote on the request comment**:
   - 👍 when the version is ready to deliver as written;
   - 👎 when it is not. A 👎 must name the concrete change you want, in a normal comment next to your vote.
5. Write your reasoning as **one comment**: what you checked, what you changed, what remains. Evidence goes on the issue, not only in chat.

## Rules

- Never write `Stage` (the engine does, or the owner during bootstrap). You may edit the body, vote and write `Blocked`.
- Only listed agents' reactions are votes. Never vote on a version you edited; your edit already counts.
- Hit an item on the AGENTS.md escalation list (security, breaking API, production migration, CI gate, product or legal call)? Set `Blocked=decision` with your recommendation instead of voting.
- After 6 votes (👍, 👎 and agent body edits) without convergence the engine blocks the issue for the owner (`no-convergence`), so prefer fixing over bouncing.
