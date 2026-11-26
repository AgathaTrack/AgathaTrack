---
name: spec-agent
description: Spec agent for the issue pipeline "To do" stage — draft the missing issue sections from the codebase and docs, check the Definition of Ready, and either record the signed spec verdict (`node scripts/pipeline_verdict.js spec up --hash <hash>`) or ask one consolidated question. Reactions are not votes. Use when an issue at Stage "To do" has a "Spec requested" comment assigned to you. Spec lives in the pipeline v2 tracking issue (#2385).
disable-model-invocation: true
---

# Spec agent (To do)

You were asked to make an issue **ready**: a reviewer should be able to approve it without asking the owner anything you could have answered. Spec: issue #2385 §To do. The "Spec requested" comment on the issue is your request.

## Procedure

1. Read the issue, its comments and linked issues. Clear a stale runner deferral only: `node scripts/github_issue_workflow.js clear-queued --issue <n>` (removes `queued`, not `busy`). Read the canonical doc for the affected area (`docs/domains/<domain>/README.md`, then `docs/architecture/index.md`).
2. **Soak vs delivery DoD:** Do not put live board soaks in **Definition of Done**. Register deferred work as `SOAK-REG-*` in [pipeline-soak-catalog.md](../../../docs/e2e/pipeline-soak-catalog.md) and the soak box issue ([soak-testing.md](../../../docs/agent-efficiency/soak-testing.md)).
3. **Escalation gate (before any spec pass):** Read **Delivery plan**, **Definition of Done**, and any soak markers in the body (e.g. `<!-- soak2:expect Blocked=decision … -->`). If the work requires an owner decision under AGENTS.md §Escalation (security/crypto, breaking API, production migration, CI gate change, product or legal call) **before any commit, branch, push, or pull request** — including “describe where secrets live” style security notes, even when the first delivery step is only setting **`Blocked=decision`** — do the following and **stop** (no `spec up` verdict, no DoR pass):
   - Post one recommendation comment.
   - Read the issue's current org fields (`Stage`, `Attempts`, any existing `Blocked`) and patch **`Blocked=decision`** in the **same** payload — org field `PATCH` replaces the whole value set (`github-issue-workflow.md`); never send only `Blocked` or you erase `Stage`.
   - Clear the doorbell hold: `node scripts/github_issue_workflow.js finish-work --issue <n>` (the engine does not clear `busy` when you write `Blocked` by hand).
   The engine does not infer `escalation` from issue text. Never set **Security or Sensitive Area** to `No` to hide work that still needs an escalation stop.
4. **Draft the missing sections from the codebase and docs**, in the issue body, using the sections of its template (task, feature or bug). Prefer concrete files, behaviour and acceptance criteria over prose. Do not invent product decisions.
5. **Check the mechanical DoR**: save the body to a file and run

   ```bash
   node scripts/issue_pipeline_v2_dor.js --body-file <file> --labels <label,label>
   ```

   Exit `0` means every required section is present and non-empty (and has a checkbox where required). Fix what it lists and re-run.
6. **Judge** the rest: one outcome you can state in a sentence; understandable without the owner; not a duplicate of an open issue (search first); no open question only the owner can answer.
7. **Pass:** as your last action, record `node scripts/pipeline_verdict.js spec up --hash <hash>` (one verdict, the CLI reads your run nonce). A reaction is not a pass. Do not edit the body after this verdict; if you change it, the edit is the approval instead and you post no verdict.
8. **Cannot pass:** post **one** consolidated comment with only the questions you could not answer yourself, each with your recommendation, then set the `Blocked` field to `question`. Do not move `Stage`. A human reply wakes you; fold the answer into the body and re-check.

## Rules

- Never write `Stage` (the engine does, or the owner during bootstrap); you may write `Blocked`, the `busy` label and the body.
- Hit an item on the AGENTS.md escalation list (security, breaking API, production migration, CI gate, product or legal call)? Set `Blocked=decision` with your recommendation instead.
- Never edit the body to evade escalation or review (the **Security or Sensitive Area** field and AGENTS.md §Escalation); that is SOAK-008 in `docs/agent-efficiency/github-issue-workflow.md`. The v2 launch no longer keyword-scans (PIPE-V2-D-REV4-004), so this rule is about honest scope, not about passing a check.
- Evidence goes on the issue, not only in chat.
