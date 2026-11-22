---
title: Pipeline v2 review process v3
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-21
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, review]
---

# Pipeline v2: review process v3 (spec, revision 3)

**Proposal** (`status: proposed` per [`docs/domains/documentation/standards.md`](../../domains/documentation/standards.md)) — not active in the engine until delivery phases **P1–P6** land and owner accepts. When accepted, this replaces the review lanes in [#2428](https://github.com/AgathaTrack/AgathaTrack/issues/2428) and the convergence rule in [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385). It does **not** change `Stage` values or `Blocked` reasons.

Canonical pointer while proposed: [`github-issue-workflow.md`](../github-issue-workflow.md) §Pipeline v2 (shipped behaviour).

---

## 1. Terms

- **Identity (type):** a config entry: `cursor-a`, `claude-a`, `cursor-b`, `claude-b`. A type names who is called; it is not one agent that keeps voting.
- **Run:** one doorbell, which starts a new agent of a type. The run is the unit of independence. The same type called again is a different agent, and that stays true when it wrote an earlier round.
- **Brand:** the runner type, `cursor` or `claude`. Brand is a property of an identity.
- **Tier:** `a` (normal review) or `b` (challenge). Each identity has one tier in config.
- **Runner:** one doorbell run. Every doorbell starts a fresh runner, so no agent remembers earlier rounds.
- **Round:** one step in a tier's sequence, with one identity doing one job.
- **Attempt:** one try at a round. A round has at most two attempts.
- **Last body author:** the identity whose change produced the current body hash. It is **unknown** when the login is shared and no verified edit claim exists.
- **Fallback:** a round assigned without brand alternation. Marked `fallback=true`.

## 2. Config

Each agent has an id, a brand, a model, an effort level, a tier, a login and its methods.

**On `main` today (pre-P1):** three identities in `.github/pipeline-agents.json`, no `tier` field, no `claude-b`.

**Target entries (after P1–P2 land):**

| Identity | Tier | Login | Notes | Lands in |
|----------|------|-------|--------|----------|
| cursor-a | a | pawpet-bot | executor-capable | P1 (`tier`); model unchanged |
| claude-a | a | pawpet-claude | `claude-haiku-5-5`, effort stored not yet on CLI | P1 |
| cursor-b | b | pawpet-bot | | P1 |
| claude-b | b | pawpet-claude | `claude-opus-5-5`, effort stored; signed verdicts required | P2 (not P1: two ids on one login before P2) |

Shared logins are allowed. The **run** is the unit of independence, not the type and not the login. Type is used only to choose who is called next. Only tier-a types are called before the challenge tier starts (§7).

## 3. Assignment

For each round, given its tier and the previous round's author:

1. **Candidates:** identities in the tier that are not down (section 4).
2. **Alternation:** choose the least recently used candidate whose brand differs from the previous author's brand. The round is `fallback=false`.
3. **Fallback:** if there is no such candidate, choose the least recently used candidate of the previous author's brand. The round is `fallback=true`. The same identity may repeat.
4. **No candidate:** the issue becomes `Blocked=stalled`.

With no history, least recently used falls back to config order.

**Relationship to shipped pickup (until P4):** adversarial pickup still uses the **board-wide round robin** in [`PIPE-V2-D-SOAK-006`](../github-issue-workflow.md) (newest `v2:launch` on the board). Per-issue LRU was rejected in soak ([`PIPE-V2-D-SOAK-002`](../github-issue-workflow.md), superseded).

**From P4:** this spec **replaces** open adversarial review with fixed rounds. **Least recently used** for round assignment is still **board-wide**, derived from round markers and launch records on the board (same cursor idea as SOAK-006, scoped to the tier's candidate set). It does not store a separate LRU field and does not use per-issue rotation.

## 4. Down state

- An identity is **down** on an issue after two consecutive failed attempts within the current tier.
- A successful attempt resets its count.
- Entering the challenge tier resets all counts.
- The state is derived from markers, not stored.

## 5. Convergence

One green on the current body hash converges the issue when the green comes from a run other than the run that wrote that hash. The green is agreement with the body the previous round left behind. A second green is not required.

- Attribution of a body edit to a run uses the nonce in a verified `edit` claim. Spec and review runs must post that claim when they edit. Without it the edit cannot be tied to a run, and convergence waits for the engine to see one.
- A round that edits the body changes the hash, so a later round's vote applies to the new hash only.
- The two-approval rule for unknown authors and the six-vote cap are superseded for In analysis (PIPE-V2-D-REV3-003), so they do not apply after P4.
- Authorship comes from the open round the engine started, matched on login within tier a (REV3-003). An `edit` claim is audit only. Challenge-tier attribution is an open decision (REV3-003).

## 6. Normal tier (a)

The writer is the least recently used tier-a identity. The spec pass moves the issue from **To do** to **In analysis**. This is the To do gate, not convergence.

| Round | What the round does |
|-------|---------------------|
| R1 writer | Writes the spec into the body; spec pass (Definition of Ready) moves **To do → In analysis**. Not a review round; no convergence vote. |
| R2 review | Votes on the current hash. Green: comment, converge, **Ready**. Not green: comment with the disagreement and reasoning, change the body with suggestions |
| R3 answer | Same as R2 |
| R4 review | Same as R2. Not green: comment, change the body, then enter the challenge tier |

- **Budget:** three reviews after the spec (R2, R3, R4).
- **Fast path:** R2 green converges immediately.
- **Implicit approval:** removed. Every convergence is an explicit green on the current hash.
- **Red:** a red must edit the body with its reasons. A red that does not edit keeps its round open on the same hash; the other brand does not receive the rejected body. The round ends on an edit (new hash) or on silence at `reviewTimeoutMin`, and a silent timeout counts as a failed attempt. The deviation is logged (PIPE-V2-D-REV3-005).

## 7. Challenge tier (b)

| Round | What the round does |
|-------|---------------------|
| C1 proposal | Votes on where the issue stands. Green: comment, converge, **Ready**. Not green: review the state, return to the original intent, look for other solutions, change the body with a new solution, document the reasoning |
| C2 review | Same as R2 |
| C3 answer | Same as R2 |
| C4 final review | Votes. Green: converge, **Ready**. Not green: comment with the reasoning, then `Blocked=no-convergence` |

- **Entry:** the challenge tier starts from R4's markers, which stay unchanged. Alternation for C1 uses R4's author as the previous author.
- **Budget:** four rounds, separate from the normal tier.

## 8. Other rules

- **Human edits:** a human edit does not reset any budget. The next round in sequence runs. To restart, a human moves `Stage` back to **To do**.
- Round budgets are the only caps. Failed attempts, negative votes and edits don't count toward any other cap.
- **Label:** `challenge` mirrors the derived tier. The engine writes it. It's an exception to the no-state-in-labels rule, alongside `busy` and `manual-only`.
- **Markers:** each round writes a marker with: round, tier, identity, brand, runner id, attempt, fallback flag, last body author identity, and failure class if any. Runner ids are audit data only.

## 9. Timers and triggers

- **Round watcher:** when a doorbell starts, a short job starts too. It sleeps until the round deadline. On waking, it checks for a result. If there is one, it exits. If not, it writes a failure marker and runs assignment again. Watchers are idempotent: a repeat wake for the same round does nothing.
- **Deadline:** starts at `reviewTimeoutMin` (30 minutes), which is measured and then lowered.
- **Event triggers:** verdict comments, human comments, and workflow completion for doorbell runs. Each one requests a tick for that issue only.
- **Per-issue serialization:** every engine entry point (verdict or comment events, watcher timeout, cron backstop, manual dispatch) must acquire the same **per-issue lease** (or equivalent compare-and-set on the active round marker) before assignment or stage writes. Only one tick may advance a round at a time; idempotent watcher wakes that lose the lease exit without side effects.
- **Backstop:** the existing cron (:11, :41) runs all open rounds. It is there for missed events and watchers, not as the primary timer. Cron uses the same per-issue lease as events and watchers.
- Engine comments don't trigger the engine.
- **Latency:**
  - event handoffs: target under 5 minutes, excluding agent run time;
  - timeouts: about a minute after the deadline, because the watcher wakes on time;
  - To do intake: until the projects trigger is confirmed, it waits for the backstop cron.
- **Cost:** the repo is public, so the hosted runners for watchers and engine runs are free. Agent run costs are unchanged.

## 10. Blocked outcomes

| Reason | When | Who clears it |
|--------|------|----------------|
| `no-convergence` | C4 not green | a human |
| `stalled` | no candidate in the tier, or both attempts of a round failed | a human, after checking infrastructure |
| `decision` | an AGENTS.md escalation item (unchanged) | the owner |

## 11. Execution

- Execution is by a tier-a identity with executor capability. Today that's **cursor-a** alone.
- Execution uses the same assignment and attempt rules. With one executor, a failure falls back to a fresh cursor-a runner.
- If the executor is down, the issue is `Blocked=stalled`.

## 12. Audit and health

The health note reports:

- fallback convergences, by issue;
- down events, by identity;
- watchers that didn't fire on time;
- issues stalled on one identity.

A fallback convergence is always visible, since it's the accepted identity repeat.

## 13. Delivery plan

Each phase is a separate PR, reviewable on its own. Each one updates the canonical doc and the decision log.

| Phase | Content | Depends on | Acceptance |
|-------|---------|------------|------------|
| P0 | owner decisions | — | recorded in the decision log |
| P1 | `tier` on identities; `claude-a` runs `claude-haiku-5-5` via `claude_args --model` (effort stored in config, CLI wiring after live proof) — **#2520** | P0 | live dispatch shows haiku in logs; cost recorded |
| P2 | shared-login signed verdicts; **claude-b** added; review-path reactions fixed for shared logins — **#2521** | P1 | both Claude ids sign verdicts the engine accepts (T4 live) |
| P3 | failure classes in markers | P1 | a forced failure produces a marker with the correct class |
| P4 | assignment, down state, convergence and the normal and challenge sequences in the pure decision function, with table tests; dry-run only | P2, P3 | table tests pass; dry-run over beta issues shows the expected rounds |
| P5 | round watchers, event triggers, the cron backstop, and the Claude completion dispatch | P4 | a round completes under 5 minutes excluding agent time; a silent round fires its watcher on time |
| P6 | soak: dry-run for a day, then on for beta issues, including a forced fallback and a forced challenge | P5 | a beta issue reaches **Ready** through the new flow, with its fallback logged |

**P5** is a sensitive workflow change, so it needs owner approval to merge. **P1** is also sensitive.

## 14. Tests

Required before P6:

- the happy path: R1, then R2 green, then **Ready**;
- R2 and R3 not green, R4 green;
- the full normal tier failing, then challenge C1 green;
- the full challenge tier failing, then `no-convergence`;
- two failed attempts on a round, then `stalled`;
- one identity down, then a fallback round that repeats the brand;
- a fallback round whose identity converges, marked `fallback=true`;
- the three #2480 scenarios, which must still be rejected when the identities are unknown or differ;
- a human edit mid-sequence, with no budget reset;
- first boot with no history;
- a repeated watcher wake, which must do nothing.

## 15. Open items

- The deadline value. It stays at 30 minutes until P1 to P3 give measured run times.
- Whether the projects trigger fires for To do moves. This is tested in P5. Until then, To do intake waits for the backstop cron.
- **`--effort` on Claude Code action:** not wired until a live run confirms the flag (P1 records effort in config only).

## 16. Shipped deviations (recorded)

| Item | Spec | Delivered | Notes |
|------|------|-----------|--------|
| P1 claude-b | Both Claude models in P1 | claude-b in **P2** | Two identities on `pawpet-claude` need signed verdicts first ([#2520](https://github.com/AgathaTrack/AgathaTrack/pull/2520), [#2521](https://github.com/AgathaTrack/AgathaTrack/pull/2521)). |
| Effort CLI | model + effort on wire | model only | `--model` via `claude_args` is documented; `--effort` unverified in official action docs. |
| claude-b in pool before P4 | implied P4 tier pools | **P2** adds claude-b to general ring | Beta issues only; paused soak fixtures unaffected. Documented in #2521. |
| Review reactions (pre-P4) | explicit greens in v3 | **#2521** ignores shared-login reactions on review path | Aligns shipped code with canonical doc; Cursor pair already on signed path. |