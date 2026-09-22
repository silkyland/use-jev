#!/usr/bin/env node
/**
 * use-jev — MCP server for TypeSafe's System One API (model: Jev).
 *
 * Jev is NOT a chat or code model. It takes a `state` plus typed questions and
 * returns typed answers with calibrated probabilities:
 *   noul   -> probability that a yes/no statement is true (0..1)
 *   choice -> one option from a set, plus per-option probabilities + confidence
 *   score  -> probability-weighted position on ordered levels + confidence
 *
 * API contract: https://docs.typesafe.ai/api
 * The escalation model, the pre-call routing and the gate are adapted from
 * jev-use (MIT, github.com/shitianfang/jev-use).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { availableProviders, resolve } from "./lib/config.mjs";
import { gate, judge } from "./lib/judge.mjs";
import { ESCALATION_REASONS, REPORTED_CONFIDENCE_THRESHOLD, ESTIMATED_CONFIDENCE_THRESHOLD, route } from "./lib/protocol.mjs";
import { NAME, VERSION, tildify } from "./lib/paths.mjs";

const config = resolve(process.argv.slice(2), process.env);

/* ------------------------------------------------------------------ helpers */

const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
const err = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

/** Every judging tool needs a backend; report the problem once, consistently. */
const needsBackend = (handler) => async (args) => {
  if (!config.backend) {
    return err(
      `${config.problem}\n\nRun jev_status for the full picture. ` +
        `For a keyless dry run, restart this server with JEV_BACKEND=mock.`,
    );
  }
  try {
    return await handler(args);
  } catch (e) {
    return err(`use-jev: ${e.message}`);
  }
};

const single = async ({ state, model, question, threshold }) => {
  const result = await judge(config.backend, {
    state,
    model,
    confidenceThreshold: threshold ?? config.confidenceThreshold,
    maxStateTokens: config.maxStateTokens,
    questions: { answer: question },
  });
  const { id, ...verdict } = result.verdicts[0];
  return ok({
    ...verdict,
    backend: result.backend,
    model: result.model,
    latencyMs: result.latencyMs,
    usage: result.usage,
  });
};

/* ------------------------------------------------------------------ schemas */

const stateSchema = z
  .union([z.string(), z.record(z.string(), z.any()), z.array(z.any())])
  .describe(
    "Everything Jev may consider — it sees nothing else. A plain string, or a JSON object/array for " +
      "records, logs or app state. Questions reference nested values with backticked paths like " +
      "`ticket.messages[0].text`. Keep it under ~30k tokens or the batch is handed back as oversized.",
  );

const instructionsSchema = z
  .union([z.string(), z.record(z.string(), z.any()), z.array(z.any())])
  .describe(
    "The judgment to make, complete in itself. Use an object to separate the question from data it " +
      'references, e.g. {"candidate": {...}, "question": "Is this the same person as `candidate`?"}.',
  );

const modelSchema = z.string().optional().describe("Model or alias. Defaults to the configured backend's own default.");
const thresholdSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe(
    `Escalate below this confidence. Defaults to ${REPORTED_CONFIDENCE_THRESHOLD} for model-reported ` +
      `confidence and ${ESTIMATED_CONFIDENCE_THRESHOLD} for confidence estimated from the distribution.`,
  );

/* ------------------------------------------------------------------- server */

const server = new McpServer({ name: NAME, version: VERSION });

server.registerTool(
  "jev_ask",
  {
    title: "Ask Jev typed questions",
    description:
      "PRIMARY TOOL. Evaluate one state against many typed questions in a SINGLE call. Jev ingests the " +
      "state once and answers every question against it in parallel, so batching is where the speed comes " +
      "from — never one call per question. Questions cannot see each other's answers, so include speculative " +
      "ones and read only the answers that apply. " +
      "Every question returns a verdict; one with escalate:true is yours to take over (reason: " +
      ESCALATION_REASONS.join(" | ") +
      "), and an escalated verdict still carries its answer as a prior. " +
      "If the items to judge sit in a file or in tool output, use the `use-jev judge` CLI from a shell " +
      "instead, so the data never travels through this conversation twice.",
    inputSchema: {
      state: stateSchema,
      questions: z
        .union([
          z.record(
            z.string(),
            z.object({
              type: z.enum(["noul", "choice", "score"]),
              instructions: instructionsSchema,
              criteria: z
                .any()
                .optional()
                .describe(
                  'noul: optional {"true": "...", "false": "..."}. ' +
                    "choice: REQUIRED map of option -> description (or null), 2-255 options. " +
                    "score: REQUIRED ordered array of 2-10 level descriptions, lowest first, each describing " +
                    "a concrete situation rather than low/medium/high.",
                ),
            }),
          ),
          z.string(),
        ])
        .describe(
          "Map of your own question id -> question. Verdicts come back under the same ids. Ids are never " +
            "sent to the model, so put the full meaning in `instructions`.",
        ),
      model: modelSchema,
      threshold: thresholdSchema,
    },
  },
  needsBackend(async ({ state, questions, model, threshold }) =>
    ok(
      await judge(config.backend, {
        state,
        questions,
        model,
        confidenceThreshold: threshold ?? config.confidenceThreshold,
        maxStateTokens: config.maxStateTokens,
      }),
    ),
  ),
);

server.registerTool(
  "jev_noul",
  {
    title: "Jev yes/no probability",
    description:
      "ONE yes/no question, returning the probability the answer is yes (0..1). A noul carries no reported " +
      "confidence: 0.5 means yes and no are equally likely, not 'medium intensity'. Use one noul per label " +
      "when several labels may apply at once. For more than one question use jev_ask.",
    inputSchema: {
      state: stateSchema,
      question: instructionsSchema,
      true_means: z.string().optional().describe("What a yes (near 1) means."),
      false_means: z.string().optional().describe("What a no (near 0) means."),
      model: modelSchema,
      threshold: thresholdSchema,
    },
  },
  needsBackend(({ state, question, true_means, false_means, model, threshold }) => {
    const criteria = {};
    if (true_means) criteria.true = true_means;
    if (false_means) criteria.false = false_means;
    return single({
      state,
      model,
      threshold,
      question: { type: "noul", instructions: question, ...(Object.keys(criteria).length ? { criteria } : {}) },
    });
  }),
);

server.registerTool(
  "jev_choice",
  {
    title: "Jev pick one option",
    description:
      "Pick ONE option from a set you define, with a probability for every option and Jev's own confidence. " +
      "Confidence measures how concentrated the distribution is — not correctness, and not permission to act. " +
      "Include a no-match option when nothing may fit. For more than one question use jev_ask.",
    inputSchema: {
      state: stateSchema,
      instructions: instructionsSchema,
      options: z
        .record(z.string(), z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any()), z.null()]))
        .describe("Map of option -> rubric description (null when the label speaks for itself). 2-255 options."),
      model: modelSchema,
      threshold: thresholdSchema,
    },
  },
  needsBackend(({ state, instructions, options, model, threshold }) =>
    single({ state, model, threshold, question: { type: "choice", instructions, criteria: options } }),
  ),
);

server.registerTool(
  "jev_score",
  {
    title: "Jev rate on a rubric",
    description:
      "Rate the state along ordered levels you define. Returns a probability-weighted score that can land " +
      "between levels, the legend, per-level probabilities and confidence. Each level must describe a " +
      "concrete situation and stand on its own. For more than one question use jev_ask.",
    inputSchema: {
      state: stateSchema,
      instructions: instructionsSchema,
      levels: z
        .array(z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]))
        .min(2)
        .max(10)
        .describe("Ordered level descriptions, lowest first. 2 to 10 levels."),
      model: modelSchema,
      threshold: thresholdSchema,
    },
  },
  needsBackend(({ state, instructions, levels, model, threshold }) =>
    single({ state, model, threshold, question: { type: "score", instructions, criteria: levels } }),
  ),
);

server.registerTool(
  "jev_gate",
  {
    title: "Gate one action with Jev",
    description:
      "Risk-check ONE proposed action against the current state in a single call. Returns " +
      "{decision: allow|deny|ask, confidence, confidenceFrom, hint}. `ask` means Jev was not confident " +
      "enough either way — judge it yourself; an unsure gate never reads as an allow. " +
      "Use this by hand only for a one-off irreversible action. If you want EVERY tool call gated, do not " +
      "call this each turn: wire `use-jev gate --hook` as a PreToolUse hook once (see hooks/gate.hooks.json) " +
      "and the decision leaves the conversation entirely, costing no LLM tokens at all.",
    inputSchema: {
      state: stateSchema,
      tool: z.string().describe("Name of the tool or command about to run."),
      input: z.string().describe("The action's input or arguments, verbatim."),
      description: z.string().optional().describe("What the action is meant to accomplish."),
      threshold: thresholdSchema,
    },
  },
  needsBackend(async ({ state, tool, input, description, threshold }) =>
    ok(await gate(config.backend, { state, tool, input, description, confidenceThreshold: threshold ?? config.confidenceThreshold })),
  ),
);

server.registerTool(
  "jev_route",
  {
    title: "Decide whether a step is Jev's at all",
    description:
      "Free, local, no network: answer two facts about a step and get told who should take it. A step that " +
      "must produce new content, or whose options cannot be listed, is the LLM's by construction and should " +
      "never cost a Jev call to discover. Use it when unsure whether to reach for jev_ask.",
    inputSchema: {
      produces_content: z.boolean().describe("Must the step produce new text, code or free-form arguments?"),
      enumerable: z.boolean().describe("Can every acceptable outcome be listed up front?"),
    },
  },
  async ({ produces_content, enumerable }) =>
    ok({
      ...route({ producesContent: produces_content, enumerable }),
      note:
        "to:'jev' means the step is expressible as a typed question — batch it into jev_ask. " +
        "to:'llm' means take it yourself; 'writing' and 'open_ended' are the two structural reasons.",
    }),
);

server.registerTool(
  "jev_models",
  {
    title: "List Jev models",
    description: "List the model names and aliases the active backend accepts. Not every backend supports this.",
    inputSchema: {},
  },
  needsBackend(async () => {
    if (typeof config.backend.models !== "function") {
      return err(`Backend "${config.backend.name}" does not expose a model list. Its default is ${config.backend.defaultModel}.`);
    }
    return ok({ backend: config.backend.name, models: await config.backend.models() });
  }),
);

server.registerTool(
  "jev_status",
  {
    title: "Check use-jev configuration",
    description:
      "Report the active backend, where its credential came from, and which other providers are configured. " +
      "Never returns a key. Call this first when a jev_* tool reports an auth or configuration problem.",
    inputSchema: {
      verify: z.boolean().optional().describe("Also make a live call to confirm the credential works."),
    },
  },
  async ({ verify }) => {
    const status = {
      server: `${NAME} ${VERSION}`,
      requested_backend: config.requestedBackend,
      active_backend: config.backendName,
      credential_source: config.credentialSource ?? "none",
      default_model: config.defaultModel ?? null,
      config_file: tildify(config.configPath),
      config_file_found: config.configLoaded,
      confidence_threshold_override: config.confidenceThreshold ?? null,
      providers: availableProviders(process.env, config.configPath),
    };
    if (!config.backend) {
      status.problem = config.problem;
      return ok(status);
    }
    if (verify) {
      try {
        const probe = await judge(config.backend, {
          state: "ok",
          questions: { probe: { type: "noul", instructions: "Is this string non-empty?" } },
        });
        status.live_check = probe.verdicts[0]?.reason === "unreachable" ? "failed" : "ok";
        if (status.live_check === "failed") status.live_check_error = probe.error ?? probe.verdicts[0]?.hint;
        else status.live_check_model = probe.model;
      } catch (e) {
        status.live_check = "failed";
        status.live_check_error = e.message;
      }
    }
    return ok(status);
  },
);

server.registerTool(
  "jev_howto",
  {
    title: "How to use Jev correctly",
    description:
      "Read this BEFORE the first jev_* call in a task if you are unfamiliar with TypeSafe. What Jev is and " +
      "is not, how to route a step to it, how to pick a primitive, and how to read probability and confidence.",
    inputSchema: {},
  },
  async () =>
    ok({
      what_jev_is:
        "A System One model: it returns typed judgments with calibrated probabilities. It does NOT generate " +
        "text, write code, explain its reasoning or hold a conversation, and it cannot power a coding agent.",
      the_real_win:
        "This is a RATE win, not a token win — Jev spends MORE tokens per decision than an LLM would, at a " +
        "far lower price per token and in a few hundred milliseconds. The saving is real when the decision " +
        "LEAVES the conversation: a hook, or a script piping a file to the CLI. Data pasted into jev_ask " +
        "travels through your context twice, as tool input and as the verdict coming back.",
      routing: {
        "step produces new text or code": "Yours. Do not call Jev (jev_route says writing).",
        "options cannot be listed up front": "Yours. Do not call Jev (jev_route says open_ended).",
        "judgment over facts already in context": "jev_ask, with EVERY question about that state in ONE call.",
        "items sitting in a file or tool output": "`use-jev judge` from a shell, so the data never enters context.",
        "one irreversible action to risk-check": "jev_gate.",
        "every tool call needs gating": "Wire `use-jev gate --hook` as a PreToolUse hook once. Zero LLM tokens.",
      },
      picking_a_primitive: {
        noul: "Whether a condition holds. Probability of yes. No reported confidence. One per label when several may apply.",
        choice: "One of a defined set. Returns the pick, every option's probability, and confidence.",
        score: "Degree along an ordered dimension. Probability-weighted value between levels, plus confidence.",
      },
      writing_good_questions: [
        "Put everything the judgment needs into `state`; Jev sees nothing else.",
        "Question ids never reach the model, so `instructions` must carry the complete meaning.",
        "Ask one narrow, coherent judgment per question; split independently useful dimensions.",
        "Score levels must describe concrete situations, not 'low/medium/high'.",
        "To select a value out of source text, find the candidates in code first — Jev cannot pick one you omitted.",
        "Include a no-match option when nothing may fit.",
      ],
      reading_the_answer: [
        "A noul near 0.5 means yes and no are similarly likely, not medium intensity.",
        "confidenceFrom:'reported' is Jev's own head (choice/score only); 'estimated' is derived from the " +
          "distribution and reads lower, which is why it escalates below a lower threshold.",
        "escalate:true is yours to take over, but the answer is still there — use it as a prior.",
        "Typed output guarantees the interface, not the truth. Re-tune thresholds on your own data.",
      ],
      limits: {
        context: "64k tokens per request for state plus all questions; 32k for state plus the longest single question.",
        input: "Text only. Pre-process images, audio or binaries into text or structured fields first.",
        language: "English is strongest. Other languages work but test before relying on them, and watch confidence.",
      },
      docs: {
        index: "https://docs.typesafe.ai/llms.txt",
        api: "https://docs.typesafe.ai/api.md",
        primitives: "https://docs.typesafe.ai/primitives.md",
        confidence: "https://docs.typesafe.ai/confidence.md",
        patterns: "https://docs.typesafe.ai/patterns.md",
        known_weaknesses: "https://docs.typesafe.ai/model-jaggedness/jev-1.13.md",
      },
    }),
);

/* -------------------------------------------------------------------- boot */

await server.connect(new StdioServerTransport());
process.stderr.write(
  `${NAME} ${VERSION} ready — backend: ${config.backendName ?? "NONE"}` +
    `${config.backend ? ` (${config.credentialSource}), model: ${config.defaultModel}` : ` — ${config.problem}`}\n`,
);
