/**
 * The engine: screen -> call the backend -> gate on confidence -> verdicts.
 *
 * A verdict always comes back for every question asked, even one that never
 * reached the provider. `escalate: true` means the caller has to take it over;
 * `reason` says why and `hint` says what to do. Adapted from jev-use (MIT).
 */

import { BackendError } from "./backends.mjs";
import {
  DEFAULT_MAX_STATE_TOKENS,
  certainty,
  coerceQuestions,
  estimateTokens,
  margin,
  thresholdFor,
  whyUnaskable,
} from "./protocol.mjs";

const handBack = (id, type, reason, hint) => ({
  id,
  type,
  answer: null,
  confidence: 0,
  confidenceFrom: "estimated",
  escalate: true,
  reason,
  hint,
});

/**
 * Structural checks that need no model: can each question be expressed in Jev's
 * primitives, are the ids unique, and does the state fit?
 */
export function screen(state, questions, { maxStateTokens = DEFAULT_MAX_STATE_TOKENS } = {}) {
  const ids = Object.keys(questions);
  const tokens = estimateTokens(state);

  if (tokens > maxStateTokens) {
    return {
      sendable: [],
      handedBack: ids.map((id) =>
        handBack(
          id,
          questions[id]?.type ?? "unknown",
          "oversized",
          `State is ~${tokens} tokens, over the ${maxStateTokens} limit. Shrink it (summarize, drop stale entries, ` +
            `split the batch) or take this question yourself.`,
        ),
      ),
      oversized: true,
      stateTokens: tokens,
    };
  }

  const sendable = [];
  const handedBack = [];
  for (const id of ids) {
    const problem = whyUnaskable(questions[id]);
    if (problem) handedBack.push(handBack(id, questions[id]?.type ?? "unknown", "open_ended", `questions.${id}: ${problem}`));
    else sendable.push({ id, ...questions[id] });
  }
  return { sendable, handedBack, oversized: false, stateTokens: tokens };
}

/**
 * Turns one raw answer into a verdict, escalating when confidence falls under
 * the threshold for its source. An escalated verdict KEEPS its answer — it is a
 * prior worth reading, not a blank.
 */
function toVerdict(question, raw, override) {
  const reportedConfidence = typeof raw.confidence === "number";
  const confidenceFrom = reportedConfidence ? "reported" : "estimated";
  const confidence = reportedConfidence
    ? raw.confidence
    : question.type === "noul"
      ? certainty(raw.answer)
      : margin(raw.distribution);

  const threshold = override ?? thresholdFor(confidenceFrom);
  const verdict = {
    id: question.id,
    type: question.type,
    answer: raw.answer,
    ...(raw.distribution ? { distribution: raw.distribution } : {}),
    ...(raw.legend ? { legend: raw.legend } : {}),
    confidence,
    confidenceFrom,
    escalate: confidence < threshold,
  };

  if (verdict.escalate) {
    verdict.reason = "unsure";
    verdict.hint =
      `Confidence ${confidence} is under the ${confidenceFrom} threshold ${threshold}. The answer is a prior, ` +
      `not a decision — reason it out yourself, or narrow the question.`;
  }
  return verdict;
}

/**
 * Judge a batch. Returns { verdicts, escalated, backend, model, latencyMs, usage }.
 * A provider failure does not throw: every question comes back escalated with
 * reason "unreachable", so a caller can carry on as if Jev did not exist.
 */
export async function judge(backend, { state, questions, model, confidenceThreshold, maxStateTokens }) {
  const map = coerceQuestions(questions);
  if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length === 0) {
    throw new Error("`questions` must be a non-empty map of question id -> question.");
  }

  const { sendable, handedBack, oversized, stateTokens } = screen(state, map, { maxStateTokens });
  const order = Object.keys(map);
  const byId = new Map(handedBack.map((v) => [v.id, v]));

  let meta = { backend: backend.name, model: model ?? backend.defaultModel, stateTokens };

  if (sendable.length > 0) {
    try {
      const result = await backend.judge({ state, questions: sendable, model });
      sendable.forEach((question, i) => {
        byId.set(question.id, toVerdict(question, result.answers[i], confidenceThreshold));
      });
      meta = { ...meta, model: result.model, latencyMs: result.latencyMs, usage: result.usage };
    } catch (err) {
      const detail = err instanceof BackendError ? err.message : `${err.message}`;
      for (const question of sendable) {
        byId.set(
          question.id,
          handBack(
            question.id,
            question.type,
            "unreachable",
            `${detail}. Proceed as if Jev did not exist, or retry later.`,
          ),
        );
      }
      meta = { ...meta, error: detail };
    }
  }

  const verdicts = order.map((id) => byId.get(id)).filter(Boolean);
  return {
    ...meta,
    oversized,
    verdicts,
    escalated: verdicts.some((v) => v.escalate),
  };
}

/**
 * Gate one proposed action: sugar over a single allow/deny/ask choice, with the
 * action appended to the state so the question reads against both.
 */
export async function gate(backend, { state, tool, input, description, confidenceThreshold }) {
  const action = [
    `Tool: ${tool}`,
    description ? `Description: ${description}` : null,
    `Input: ${typeof input === "string" ? input : JSON.stringify(input)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const composed =
    `${typeof state === "string" ? state : JSON.stringify(state, null, 2)}\n\n--- proposed action ---\n${action}`;

  const result = await judge(backend, {
    state: composed,
    confidenceThreshold,
    questions: {
      gate: {
        type: "choice",
        instructions: "Should the agent be allowed to run this proposed action right now?",
        criteria: {
          allow: "Safe, reversible or expected, and consistent with the stated task.",
          deny: "Destructive, irreversible, out of scope, or it exfiltrates or damages something.",
        },
      },
    },
  });

  const verdict = result.verdicts[0];
  // An escalated gate must never read as an allow: an unsure gate is an ask.
  const decision = verdict.escalate ? "ask" : verdict.answer;
  return {
    decision,
    confidence: verdict.confidence,
    confidenceFrom: verdict.confidenceFrom,
    reason: verdict.reason,
    hint:
      decision === "ask"
        ? verdict.hint ?? "Jev is not confident enough either way — judge this action yourself."
        : undefined,
    distribution: verdict.distribution,
    backend: result.backend,
    model: result.model,
    latencyMs: result.latencyMs,
  };
}
