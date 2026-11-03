---
description: Run a debate among the agents on the board on a decision (independent views first)
argument-hint: "<the decision to debate>"
---
<!-- council-board -->
Run a debate on this, following the Debates section of `{{BOARD_DIR}}/docs/policies.md`: $ARGUMENTS

(The agents on the board are {{AGENTS}}. I call them {{GROUP}}; "ask {{GROUP}}" means this.)

The tool is `node {{BOARD_DIR}}/debate.mjs`. You're the starter: you run the debate and write the record. Budgets, deadlines, word limits and who may decide come from policy.json, and the tool enforces them.

1. **Check first.** `node {{BOARD_DIR}}/debate.mjs list --project "<project>"` shows recent decisions. Skip the debate if a similar question was decided in the last {{policy.debates.repeatDays}} days and the facts haven't changed. If I didn't ask for this debate, it must be allowed by the policy and fit its budget ({{policy.debates.budget.perRequest}} self-started per request, {{policy.debates.budget.openPerProject}} open per project, {{policy.debates.budget.perProjectPerDay}} per project per day). The tool refuses past that.
2. **Write the neutral question** to a temporary file: the decision, the options, the constraints, the criteria (correctness, risk, cost, effort, reversibility), and the facts you checked, with their sources. Don't argue your side in it. Give Codex only what it may see under the Codex policy.
3. **Seal your own view first.** Write it to a second file before anyone sees the question: at most {{policy.debates.maxWords.1}} words, with a confidence from 0 to 1.
4. **Start the debate:** `node {{BOARD_DIR}}/debate.mjs start --project "<project>" --title "<short>" --question-file <q> --view-file <v> --confidence <c> [--auto]`. Add `--auto` when you started it yourself. Leave Codex out (`--participants "<names>"`) if Codex is off for the project. The other Claude agents get a help request to join.
5. **Codex's turn** (if it takes part), in the background: `node {{BOARD_DIR}}/debate.mjs codex <id> 1`. Each round is a fresh read-only Codex run.
6. **Wait for the reveal.** `node {{BOARD_DIR}}/debate.mjs status <id>` shows who has answered. Round 1 opens when everyone has answered or at the deadline ({{policy.debates.deadlineMinutes}} minutes); a missing participant is recorded. Don't read anyone's view before then.
7. **Round 2:** write your critique (at most {{policy.debates.maxWords.2}} words, answering the strongest argument against you) and run `node {{BOARD_DIR}}/debate.mjs submit <id> 2 --file <f>`. For Codex, run `node {{BOARD_DIR}}/debate.mjs codex <id> 2`. Other Claude agents use their debate_submit tool.
8. **Merge** the views into one proposed wording. Quote positions fairly, and don't slip in your own preferences. For round 3, run `node {{BOARD_DIR}}/debate.mjs codex <id> 3 --file <merged>` and post the merged wording to the other Claude agents with the board's post tool, asking for round 3. Record your own acceptance with `submit <id> 3`. An objection means amend the wording and ask again, at most once.
9. **Close it:** `node {{BOARD_DIR}}/debate.mjs close <id> --outcome-file <f> --decided-by AIs|pending-user [--dissent "…"]`.
   - **AIs:** only if the policy lets the agents settle matters, everyone said AGREED at confidence {{policy.debates.minConfidence}} or more, and the matter is low-stakes and reversible. The tool checks what it can.
   - **pending-user:** anything else, including anything affecting results or conclusions, data, security or privacy, spending beyond the debate, large refactors or publication. Then bring me the options, your recommendation and any dissent.

   Closing writes the full record privately and, if the policy says so, a short note in `<project>/.decisions/`, which stays out of commits.
10. **Tell me in a few lines** what was decided, why, who decided, and any dissent, with the record's path. Never treat silence or a timeout as agreement.
