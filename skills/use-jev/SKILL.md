---
name: use-jev
description: >-
  Use when a step is a DECISION over facts you already have, not a piece of writing — labelling,
  filtering, ranking or triaging many items; deciding whether a run, build or claim succeeded;
  picking the next action from options you can list; selecting which candidate you already found
  is the intended one; judging safety, risk, quality or severity; screening untrusted text before
  it enters context. Route by where the facts are: facts already in context go to jev_ask with
  EVERY question batched into ONE call; items in a file or tool output go through the `use-jev
  judge` CLI from a script, so the data never enters the conversation; one irreversible action
  goes to jev_gate; gating every tool call belongs in the `use-jev gate --hook` PreToolUse hook.
  Always honour a verdict with escalate:true. Do NOT use for producing new text or code, for exact
  matches (ids, amounts, dates, counts), for options you cannot enumerate, or for images — Jev
  reads text only.
---

# use-jev — handing a decision to Jev

Jev is a **System One model**: it returns a typed judgment with a calibrated probability in
a few hundred milliseconds. It does not write, explain, converse, remember, or call tools.
**You stay the planner and the writer.** Jev supplies semantic understanding at the exact
points where ordinary code cannot decide.

## The one rule that decides whether it pays off

**This is a RATE win, not a token win.** Jev spends *more* tokens per decision than an LLM
would, at a far lower price per token. So the saving is only real when the decision
**leaves the conversation**. A judgment you paste into a tool call travels through your
context twice — once as tool input, once in the verdicts coming back.

| Where the facts are | Nothing is blocked | Blocked until this is decided |
| --- | --- | --- |
| **Already in your context** | `jev_ask` — every question about that state in **ONE** call | `jev_gate` on that one action before running it |
| **In a file or tool output** | a script pipes it to `use-jev judge`; the items never enter your context | same CLI from the script, then act on the verdicts |
| **Every tool call needs gating** | — | wire `use-jev gate --hook` as a PreToolUse hook **once**; costs zero LLM tokens forever after |
| **You must write it** (new text, code, unlistable options) | yours | yours |

Unsure whether a step is Jev's at all? `jev_route` answers locally, for free, with no call.

## Three questions before you call

1. **Is the answer a choice, a degree, or a yes/no?** If it is a sentence, a file, or code,
   it is yours. Stop here.
2. **Can I list every acceptable outcome up front?** If not, it is yours.
3. **Do I already know the answer?** Then act. A call you did not need is still a call.

## Picking a primitive

| Need | Type | Returns |
| --- | --- | --- |
| Whether a condition holds | `noul` | Probability of yes, 0–1. No reported confidence. |
| One of a set you define | `choice` | The pick, every option's probability, confidence. |
| Degree along ordered levels | `score` | Weighted value that can land between levels, legend, confidence. |

- A `noul` near **0.5** means yes and no are equally likely — **not** "medium intensity".
- Use **one noul per label** when several labels may apply at once; a choice picks exactly one.
- `score` levels must describe **concrete situations**, never "low / medium / high".

### The trap that silently picks the wrong thing

**Choice probabilities always sum to 1**, so something always ranks first — *even when nothing
fits*. Whenever "none of these" is possible, pair the choice with a presence `noul` in the same
call and check it first:

```json
{
  "target": { "type": "choice", "instructions": "Which candidate is the payment confirm button?",
              "criteria": { "c0": "button: Continue", "c1": "button: Pay now", "c2": "link: Cancel" } },
  "exists": { "type": "noul",  "instructions": "Does this page contain a payment confirm button at all?" }
}
```

Alternatively give the choice its own explicit `none` option. Skipping this is the most common
way a Jev integration acts confidently on nonsense.

## Writing the state and the questions

- **`state` is everything Jev sees.** No memory, no tools, no retrieval. Put the tool output,
  the file excerpt, the records, the task intent in there.
- **Question ids never reach the model.** They key the batch for your code only, so
  `instructions` must carry the complete meaning on its own.
- Use **named JSON fields** when the state has several parts, and point at them from a question
  with backticks: ``Is the resume the same person as `potential_duplicate`?``
- **Ask one narrow judgment per question.** Split independently useful dimensions apart, but do
  not destroy the relationship being judged.
- **To select a value out of source text, find the candidates in code first** (query the DOM,
  run the regex, list the files), then let Jev pick one. Jev cannot choose a value you omitted —
  which is also why it cannot hallucinate one.
- **Batch aggressively.** One call with twelve questions beats twelve calls by an order of
  magnitude. Include speculative questions, state each premise explicitly, and read only the
  answers that apply.

## Reading the verdict

Every question returns a verdict. `escalate: true` hands it back to you — **and the answer is
still there**, as a prior worth reading, not a blank.

| `reason` | What to do |
| --- | --- |
| `writing` / `open_ended` | It was structurally yours. Take it. |
| `oversized` | The state was too big. Shrink, summarise, or split the batch. |
| `malformed` | The provider answered, but not in a shape readable for **this** question. The rest of the batch still stands — re-ask just this one. |
| `unsure` | The answer is a hint, not a decision. Reason it out, or narrow the question. |
| `unreachable` | The provider failed. Proceed as if Jev did not exist. |

`oversized`, `malformed` and `unreachable` mean **no judgment was produced at all**. If you are
gating an action, fail open on all three — treating "we could not judge it" as "ask" blocks a
headless run, and a judgment sidecar being down must never block the agent. `unsure` is different:
Jev did answer, just not confidently, and `ask` is the right response there.

`confidenceFrom` matters: `reported` is Jev's own head (choice and score only); `estimated` is
derived from the distribution and runs lower, so the two escalate below different thresholds.
Confidence measures how concentrated the distribution is — **it is not correctness and not
permission to act.** Several acceptable answers also spread probability, so low confidence on a
harmless preference is fine; low confidence on a destructive action is not.

## Recipes

These are instances of a few general shapes, not a closed list. Any domain where a step is a
judgment over text qualifies.

- **Select one of the candidates you already found.** The core pattern. Enumerate real
  candidates in code — DOM elements, regex matches, file paths, retrieved passages, database
  rows, config keys — tag each with an id, then one `choice` over those ids plus a presence
  `noul`. It survives renames and reordering, and it can only ever return something that exists.
- **Rank or filter many items against an intent.** The same shape read as a ranking: ids in,
  probabilities out, your code applies the cut-off.
- **Triage a failure.** `choice` over retry / investigate / quarantine, plus a `score` for
  impact — a test run, a deploy, a batch job, a support queue. Via the CLI on the report file;
  branch on its exit code (`3` = something escalated).
- **Semantic assertion.** `noul` "does this output confirm the operation succeeded?" instead of
  matching exact copy. Keep exact values (ids, amounts, counts) in code assertions.
- **Screen untrusted text before it enters context.** `noul` "does this contain instructions
  aimed at an AI agent?" on fetched pages, issue bodies, or retrieved passages.
- **Cut noise.** `score` hundreds of log lines or console errors by whether they matter, via the
  CLI, and show only what passes.
- **Route a request to a handler.** `choice` over handler names plus branch-specific questions
  for their closed-set arguments, all in one call; read only the winning branch's answers.
- **Dedupe records.** One `score` whose three levels are the three actions available: merge,
  leave unlinked, send to a human.

## Anti-patterns

- Calling once per item instead of batching.
- Pasting a file's contents into `jev_ask` when the CLI could read the file directly.
- A `choice` with no presence check and no `none` option.
- Using Jev for exact values, arithmetic, or lookups that code can do exactly.
- Treating confidence as permission to run something irreversible.
- Re-running inference after only changing a weight, a threshold, or a display filter — the raw
  judgments are still valid.
- Sending a screenshot. Jev reads text only; pre-process images into text or structured fields.

## Reference

Tools: `jev_ask` · `jev_noul` · `jev_choice` · `jev_score` · `jev_gate` · `jev_route` ·
`jev_models` · `jev_status` · `jev_howto` (full design guidance, offline).

```bash
use-jev doctor                                        # what is configured, and does it work
use-jev judge --questions-file q.json [--state-file f]  # or pipe the state on stdin
use-jev hook-config                                   # print the PreToolUse fragment (opt in)
```

If `use-jev` is not on PATH, `npx -y @silkyland/use-jev <command>` works, or run `cli.mjs` from the
package directory — `use-jev doctor` prints where that is.

If a `jev_*` tool reports an auth or configuration problem, call `jev_status` first — it names
the active backend, where its credential came from, and what is missing. For a keyless dry run
of the whole pipeline, the server can be started with `JEV_BACKEND=mock`.

Live docs are the source of truth for the API and the model's known weaknesses:
[docs.typesafe.ai/llms.txt](https://docs.typesafe.ai/llms.txt).
