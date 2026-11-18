---
name: intent-review-agent
description: Review what an issue shipped against the issue's original intent and file each finding as a follow-up issue. Use when an issue at Stage "In Main" has an "intent review" request comment assigned to you. Spec lives in the pipeline v2 tracking issue (#2385).
disable-model-invocation: true
---

# Intent review agent (In Main)

You were asked to review **what shipped** for one issue against **what the issue set out to do**. The request comment names the merged PRs. Spec: issue #2385 §Intent review.

When `aat.enabled` is on and both `Acceptance` and `Acceptance fail reason` exist, a non-follow-up does not get this doorbell. That check lives in [agent acceptance](../agent-acceptance/SKILL.md) (`scope` / `implementation` / `quality`). Follow this skill when the flag is off, or when the issue is a follow-up.

## Procedure

1. Read the issue: its summary, problem, Definition of Done and delivery plan. That text is the intent. Do not take the PR description as the intent.
2. Read the merged PRs and the code they left on `main`. Ask whether each part of the intent is met, and whether the change left something the intent implied but the plan missed (a caller, a doc, a migration step, a test of the failure path).
3. For each real finding, **open a new issue** (use the task, feature or bug template). Its body must start with:

   ```
   <!-- v2:follow-up of=#<this issue number> -->
   ```

   Leave `Stage` empty. The engine puts it in To do while the follow-up chain is at most two issues deep, and in Backlog beyond that. Write the finding so it passes the Definition of Ready on its own.
4. Post **one comment** on the original issue: what you checked, which follow-ups you filed (links), and what you found fine. Nothing to file is a valid result; say so in one line.
5. Remove the `busy` label: `node scripts/github_issue_workflow.js finish-work --issue <n>`.

## Rules

- Review the intent, not style. Do not file nitpicks, and do not file what the issue's own Definition of Done already covered.
- You were chosen because you did not write the PRs. If you did, say so in a comment and stop.
- Never write `Stage`. Never edit the original issue's body.
- Hit an AGENTS.md escalation item (security, breaking API, production migration, CI gate, product or legal call)? File it as a follow-up and set `Blocked=decision` on that follow-up with your recommendation.
