/**
 * Question shapes, validation, and the confidence arithmetic behind escalation.
 *
 * Questions stay in TypeSafe's own wire shape ({type, instructions, criteria}),
 * so anything the API accepts passes through unchanged.
 *
 * The escalation model and both thresholds are adapted from jev-use
 * (MIT, github.com/shitianfang/jev-use), which calibrated them on live answers.
 */

export const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

/**
 * Why a question came back undecided.
 *   writing     - the step needs new text/code; it was never Jev's to make
 *   open_ended  - the options cannot be enumerated, or the question is malformed
 *   oversized   - the state is too large to judge; shrink it
 *   unsure      - Jev answered, but below the confidence threshold. The answer
 *                 is still there; treat it as a prior, not a decision
 *   unreachable - the provider could not be reached; proceed as if Jev did not exist
 */
export const ESCALATION_REASONS = ["writing", "open_ended", "oversized", "unsure", "unreachable"];

/**
 * Jev reports its own confidence head for `choice` and `score`, never for `noul`.
 * When it is absent we derive one from the distribution and label it "estimated".
 * The estimate reads systematically lower once losing mass splits over three or
 * more options, so it escalates below a lower number. Both numbers come from
 * jev-use's calibration; re-tune them on your own data before trusting them.
 */
export const REPORTED_CONFIDENCE_THRESHOLD = 0.5;
export const ESTIMATED_CONFIDENCE_THRESHOLD = 0.4;

export const thresholdFor = (source) =>
  source === "reported" ? REPORTED_CONFIDENCE_THRESHOLD : ESTIMATED_CONFIDENCE_THRESHOLD;

/** ~30k tokens of state, under the API's 32k state-plus-longest-question budget. */
export const DEFAULT_MAX_STATE_TOKENS = 30_000;

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** A rough character-based token estimate — enough to catch a state that is far too big. */
export function estimateTokens(state) {
  const text = typeof state === "string" ? state : JSON.stringify(state ?? "");
  return Math.ceil(text.length / 3.5);
}

/** Certainty of a noul probability: 0 at a coin flip, 1 at either extreme. */
export const certainty = (p) => round4(Math.min(1, Math.max(0, Math.abs(p - 0.5) * 2)));

/** Estimated confidence for a distribution: the winner's margin over the runner-up. */
export function margin(distribution) {
  const sorted = Object.values(distribution ?? {}).sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return round4(sorted[0]);
  return round4(Math.min(1, Math.max(0, sorted[0] - sorted[1])));
}

/**
 * Structural problems that need no model. Returns a message, or null when the
 * question is expressible in Jev's primitives.
 */
export function whyUnaskable(question) {
  if (!question || typeof question !== "object" || Array.isArray(question)) return "Must be an object.";
  if (!QUESTION_TYPES.has(question.type)) return 'type must be "noul", "choice" or "score".';
  if (question.instructions == null || question.instructions === "") return "instructions is required.";
  if (typeof question.instructions === "string" && !question.instructions.trim()) {
    return "instructions is empty.";
  }

  if (question.type === "choice") {
    if (!question.criteria || typeof question.criteria !== "object" || Array.isArray(question.criteria)) {
      return "choice criteria must be a map of option -> description (or null).";
    }
    const options = Object.keys(question.criteria);
    if (options.length < 2) return `choice needs at least 2 options; got ${options.length}.`;
    if (options.length > 255) return `choice takes at most 255 options; got ${options.length}.`;
  }

  if (question.type === "score") {
    if (!Array.isArray(question.criteria)) {
      return "score criteria must be an ordered array of level descriptions.";
    }
    if (question.criteria.length < 2 || question.criteria.length > 10) {
      return `score takes 2 to 10 levels; got ${question.criteria.length}.`;
    }
  }

  if (question.type === "noul" && question.criteria != null) {
    const unknown = Object.keys(question.criteria).filter((k) => k !== "true" && k !== "false");
    if (unknown.length) return `noul criteria only takes "true" and "false"; got ${unknown.join(", ")}.`;
  }

  return null;
}

/** Agents sometimes hand over a stringified map; a string is never a valid questions map. */
export function coerceQuestions(questions) {
  if (typeof questions !== "string") return questions;
  try {
    return JSON.parse(questions);
  } catch {
    throw new Error("`questions` was a string that is not valid JSON.");
  }
}

/**
 * Deterministic pre-call routing: the two facts that decide who takes a step.
 * A step that must produce content, or whose options cannot be listed, is the
 * LLM's by construction — it should never cost a Jev call to find that out.
 */
export function route({ producesContent, enumerable }) {
  if (producesContent) return { to: "llm", reason: "writing" };
  if (!enumerable) return { to: "llm", reason: "open_ended" };
  return { to: "jev" };
}
