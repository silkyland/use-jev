# use-jev

MCP server **and** CLI that expose TypeSafe's **System One** API (model: **Jev**) to any
MCP-capable agent — with escalation, an action gate, and four interchangeable backends.

Jev is **not** a chat or code model, and it cannot power a coding agent. It takes a `state`
plus typed questions and returns typed answers with calibrated probabilities. See
[docs.typesafe.ai](https://docs.typesafe.ai/llms.txt).

> **It is a RATE win, not a token win.** Jev spends *more* tokens per decision than an LLM
> would, at a far lower price per token and in a few hundred milliseconds. The saving is real
> only when the decision **leaves the conversation** — a hook, or a script piping a file to the
> CLI. Data pasted into `jev_ask` travels through your context twice: once as tool input, once
> in the verdicts coming back.

## Install

```bash
npx -y use-jev install          # or, from a clone: npm install && node cli.mjs install
```

`install` detects the agents present on the machine, writes an MCP entry for each, links the
bundled routing skill, and backs up every file it touches. **It never writes a credential.**
Add `--dry-run` to see the plan first, `--agent claude-code,codex` to narrow it, or
`--no-skills` to wire the tools only. `uninstall` reverses it.

Every path is resolved at run time — the package's own location, and a `node` on `PATH` whose
version matches the one running (so a Homebrew upgrade does not break the entry it wrote).
Nothing is hard-coded, so a clone works wherever you put it.

Then give it a credential and check:

```bash
export TYPESAFE_API_KEY=...     # or OPENROUTER_API_KEY, or AI_GATEWAY_API_KEY
npx -y use-jev doctor
```

Prefer a file if you want one credential for **every** agent, since it is read by whichever
agent launches the server:

```bash
mkdir -p ~/.use-jev
cp "$(npx -y use-jev doctor | awk '/package/{print $2}')/config.example.json" ~/.use-jev/config.json
chmod 600 ~/.use-jev/config.json
```

Fill in only the providers you use. `baseUrl` is an **origin** (a trailing `/v1` is tolerated).

**Headless runs need a permission rule.** No permission mode auto-allows an MCP tool, so a
non-interactive run has nobody to ask and the call is refused. Add to your agent's settings:

```json
{ "permissions": { "allow": ["mcp__use-jev"] } }
```

Nothing here writes that rule for you: pre-authorizing a tool that sends your state to a third
party is your decision.

## Tools

| Tool | What it does |
| --- | --- |
| `jev_ask` | **Primary.** One state, many typed questions, one call. A verdict per question. |
| `jev_noul` | One yes/no question → probability of yes (0–1). |
| `jev_choice` | Pick one option from a set → pick + per-option probabilities + confidence. |
| `jev_score` | Rate on ordered levels → weighted score + legend + probabilities + confidence. |
| `jev_gate` | Risk-check ONE proposed action → `allow` / `deny` / `ask`. |
| `jev_route` | Local and free: is this step Jev's at all, or structurally the LLM's? |
| `jev_models` | List the models the active backend accepts. |
| `jev_status` | Active backend, credential source, every provider's state. Never returns a key. |
| `jev_howto` | Design and routing guidance for agents without the skill installed. |

## Verdicts and escalation

Every question gets a verdict, even one that never reached the provider. `escalate: true`
means it is yours to take over — and the answer is **still there**, as a prior worth reading.

| `reason` | Meaning |
| --- | --- |
| `writing` | The step must produce new content. Structurally the LLM's. |
| `open_ended` | Options can't be enumerated, or the question is malformed. Caught before any call. |
| `oversized` | The state is over ~30k tokens. Shrink or split it. Caught before any call. |
| `unsure` | Answered below the confidence threshold. Treat the answer as a hint. |
| `unreachable` | The provider failed. Proceed as if Jev did not exist. |

`confidenceFrom` says where the number came from, and the two escalate below different
thresholds: `reported` is Jev's own head (choice/score only, threshold **0.5**), `estimated` is
the top-minus-runner-up margin (threshold **0.4**, because it reads lower once losing mass
splits over three or more options). Both are jev-use's calibration — **re-tune them on your own
data** via `--threshold`, `JEV_CONFIDENCE_THRESHOLD`, or `confidenceThreshold` in config.

### The trap worth knowing

**Choice probabilities always sum to 1**, so something always ranks first — even when nothing
fits. Whenever "none of these" is possible, pair the choice with a presence `noul` in the same
call and read that first, or give the choice an explicit `none` option.

## Backends

| Backend | Endpoint | Credential |
| --- | --- | --- |
| `typesafe` | `POST api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` / `JEV_API_KEY` |
| `openrouter` | `POST openrouter.ai/api/alpha/decisions` (alpha — the path may move) | `OPENROUTER_API_KEY` |
| `vercel` | `POST ai-gateway.vercel.sh/v4/ai/evaluation-model` | `AI_GATEWAY_API_KEY` |
| `mock` | none — local, deterministic, meaningless answers | none |

`JEV_BACKEND` picks one; unset means `auto`, taking the first credential found in the order
typesafe → openrouter → vercel. `JEV_BACKEND=mock` runs the entire pipeline offline, which is
how the test suite covers screening, escalation, the gate and the CLI without a key.

Only the `typesafe` path is verified here against live responses. The other two are implemented
from jev-use's documentation of them.

## CLI

```bash
use-jev install [--dry-run] [--agent a,b] [--no-skills]   # wire detected agents
use-jev uninstall [--dry-run]
use-jev doctor                                            # what is configured, and does it work
use-jev judge --questions-file q.json [--state-file f]    # or pipe the state on stdin
use-jev hook-config                                       # print the PreToolUse fragment
use-jev gate --hook                                       # the hook itself
use-jev serve                                             # the MCP server on stdio
```

`judge` is the path for data **already in a file**: the items never enter an agent's context.
It exits `0` when every verdict stands and `3` when any escalated, so a script can branch on it.

`q.json` is a map of question id → question, in TypeSafe's own shape:

```json
{
  "failed":   { "type": "noul",   "instructions": "Did the run fail?" },
  "next":     { "type": "choice", "instructions": "What should happen next?",
                "criteria": { "retry": "Looks flaky", "investigate": "A real failure" } },
  "severity": { "type": "score",  "instructions": "How bad is it?",
                "criteria": ["Cosmetic", "Blocks one user", "Blocks everyone"] }
}
```

## The zero-token gate

`use-jev hook-config` prints a settings **fragment** for a Claude Code `PreToolUse` hook, with
this install's own paths filled in. Merge its `hooks` key into your settings.

It only ever **tightens**: `deny` → deny with a reason, unsure → ask, `allow` → no output at all
so your normal permission flow decides. Every failure — bad input, no credential, provider down
— **fails open**, because a judgment sidecar being down must never block the agent.

It is deliberately not enabled by `install`: it sends a description of every matched tool call
to your configured provider.

- `JEV_GATE_THRESHOLD` — higher sends more actions to review.
- `JEV_GATE_STATE` — a hook event carries only the cwd and permission mode; anything else that
  changes the answer ("production credentials are present") goes here, appended to every state.

## Verify

```bash
npm test     # or: node smoke.mjs
```

Four phases as a real MCP client over stdio. The first three need **no credential** — the mock
backend runs the whole pipeline locally, covering verdicts, escalation, screening, the gate, the
route helper, path resolution and every CLI path including the hook contract. The fourth uses
your real configuration and makes live calls, or says clearly why it skipped.

## Layout

| File | Job |
| --- | --- |
| `index.mjs` | The MCP server and its nine tools |
| `cli.mjs` | `install`, `uninstall`, `hook-config`, `doctor`, `judge`, `gate --hook`, `serve` |
| `lib/paths.mjs` | Runtime path and Node resolution — the reason nothing is hard-coded |
| `lib/install.mjs` | The agent registry and the config writers |
| `lib/protocol.mjs` | Question validation, thresholds, confidence arithmetic, local routing |
| `lib/backends.mjs` | typesafe / openrouter / vercel / mock adapters, retry and backoff |
| `lib/config.mjs` | Backend and credential resolution |
| `lib/judge.mjs` | screen → call → confidence gate → verdicts; `gate` |
| `skills/use-jev/SKILL.md` | The routing rules an agent should follow |

Dependencies: `@modelcontextprotocol/sdk`, `zod`. Providers are called with plain `fetch`, so no
vendor SDK is pinned.

## Credits

The escalation contract, the two calibrated confidence thresholds, the deterministic pre-call
routing, the action gate, and the tighten-only / fail-open hook rules are **adapted from
[jev-use](https://github.com/shitianfang/jev-use)** (MIT) — as are the OpenRouter and Vercel wire
formats, which are not in TypeSafe's own docs. No source was copied; the implementations here are
independent. See [NOTICE](NOTICE).

**That project is the more complete one.** If you want something maintained, benchmarked and
npm-published rather than something small you own and edit, use it instead. This exists to keep
one credential for every agent, to expose the raw primitives faithfully, and to stay short enough
to read in one sitting.

TypeSafe, System One and Jev are products of [TypeSafe AI](https://typesafe.ai). This project is
an unaffiliated client.

## License

MIT — see [LICENSE](LICENSE).
