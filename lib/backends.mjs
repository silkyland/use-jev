/**
 * Provider adapters. Each takes one state plus already-screened questions and
 * returns canonical answers, so nothing above this file knows which provider ran.
 *
 * The OpenRouter and Vercel wire formats are documented in jev-use
 * (MIT, github.com/shitianfang/jev-use), which verified them against live
 * responses. They are NOT in TypeSafe's own docs and are not verified here —
 * if either provider moves an endpoint, this is the file that breaks.
 */

export class BackendError extends Error {
  constructor(backend, message, { status, body, retryAfterMs } = {}) {
    super(`[${backend}] ${message}`);
    this.name = "BackendError";
    this.backend = backend;
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Accepts an origin or an origin that already carries a version prefix. */
const origin = (url) => url.replace(/\/+$/, "").replace(/\/v\d+$/, "");

const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** 429/529 and transport failures retry; everything else is final. */
async function postJson(backend, url, headers, body, { maxRetries = 3, timeoutMs = 60_000 } = {}) {
  let last;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "use-jev-mcp", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      last = new BackendError(backend, `could not reach ${url}: ${err.message}`);
      if (attempt === maxRetries) throw last;
      await sleep(Math.min(500 * 2 ** attempt, 8_000));
      continue;
    }

    const text = await response.text();
    const parsed = text ? safeJson(text) : null;
    if (response.ok) return parsed ?? {};

    if (response.status === 429 || response.status === 529) {
      const header = Number(response.headers.get("retry-after"));
      last = new BackendError(backend, `${response.status} ${response.status === 429 ? "rate limited" : "overloaded"}`, {
        status: response.status,
        body: parsed ?? text,
      });
      if (attempt === maxRetries) throw last;
      await sleep(Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 30_000) : Math.min(500 * 2 ** attempt, 8_000));
      continue;
    }

    throw new BackendError(
      backend,
      response.status === 401
        ? "401 unauthorized — the configured key was rejected"
        : response.status === 422
          ? "422 validation failed; the body names the offending field"
          : `${response.status}`,
      { status: response.status, body: parsed ?? text },
    );
  }
  throw last;
}

/* --------------------------------------------- native dialect (TypeSafe/OpenRouter) */

const nativeBody = (state, questions, model) => ({
  state,
  model,
  questions: Object.fromEntries(
    questions.map((q) => [
      q.id,
      { type: q.type, instructions: q.instructions, ...(q.criteria != null ? { criteria: q.criteria } : {}) },
    ]),
  ),
});

/**
 * Reads TypeSafe's answer shape into the canonical one, preserving what it carries.
 *
 * A missing or unreadable answer marks THAT question only, as `{ error }`. It must
 * not throw: the caller is told to "batch aggressively", and abandoning 199 good
 * answers because one key came back wrong would punish exactly that. The batch as
 * a whole only fails when the transport does.
 */
function parseNative(answers, questions) {
  return questions.map((q) => {
    const a = answers?.[q.id];
    if (!a) return { error: `response is missing an answer for "${q.id}"` };
    if (q.type === "noul") {
      if (typeof a.noul !== "number") return { error: `answer "${q.id}" has no noul value` };
      return { answer: a.noul };
    }
    if (q.type === "choice") {
      if (typeof a.choice !== "string") return { error: `answer "${q.id}" has no choice` };
      return { answer: a.choice, distribution: a.probabilities, confidence: numberOr(a.confidence) };
    }
    if (typeof a.score !== "number") return { error: `answer "${q.id}" has no score` };
    return { answer: a.score, distribution: a.probabilities, legend: a.legend, confidence: numberOr(a.confidence) };
  });
}

const numberOr = (v) => (typeof v === "number" ? v : undefined);

/* --------------------------------------------------------------------- adapters */

/** TypeSafe direct: POST /v1/systemone. The primary, documented path. */
export function typesafeBackend({ apiKey, baseUrl = "https://api.typesafe.ai", defaultModel = "jev-latest", http }) {
  return {
    name: "typesafe",
    defaultModel,
    async judge({ state, questions, model }) {
      const started = Date.now();
      const res = await postJson(
        "typesafe",
        `${origin(baseUrl)}/v1/systemone`,
        { Authorization: `Bearer ${apiKey}` },
        nativeBody(state, questions, model ?? defaultModel),
        http,
      );
      return {
        answers: parseNative(res.answers, questions),
        model: res.model ?? model ?? defaultModel,
        latencyMs: Date.now() - started,
        usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
      };
    },
    async models() {
      const res = await fetch(`${origin(baseUrl)}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new BackendError("typesafe", `GET /v1/models returned ${res.status}`, { status: res.status });
      return (await res.json()).models ?? [];
    },
  };
}

/**
 * OpenRouter: Jev is NOT on /v1/chat/completions. It sits on the alpha
 * Decisions endpoint, which speaks the same native dialect as TypeSafe.
 * Alpha means OpenRouter may move this path without notice.
 */
export function openrouterBackend({ apiKey, baseUrl = "https://openrouter.ai", defaultModel = "typesafe/jev-latest", http }) {
  return {
    name: "openrouter",
    defaultModel,
    async judge({ state, questions, model }) {
      const started = Date.now();
      const res = await postJson(
        "openrouter",
        `${origin(baseUrl)}/api/alpha/decisions`,
        { Authorization: `Bearer ${apiKey}` },
        nativeBody(state, questions, model ?? defaultModel),
        http,
      );
      return {
        answers: parseNative(res.answers, questions),
        model: res.model ?? model ?? defaultModel,
        latencyMs: Date.now() - started,
        usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
      };
    },
  };
}

/**
 * Vercel AI Gateway: a different dialect. Model travels in the `ai-model-id`
 * HEADER, `noul` is renamed `boolean` with its answer in `probability`, usage is
 * camelCase, no legend is echoed, and Jev's confidence head arrives out-of-band
 * in `providerMetadata.typesafe.confidence` — keyed by question id, omitting
 * boolean answers. So a mixed batch comes back part reported, part estimated.
 */
export function vercelBackend({ apiKey, baseUrl = "https://ai-gateway.vercel.sh", defaultModel = "typesafe-ai/jev", http }) {
  const toGateway = (q) => {
    if (q.type === "noul") {
      return { type: "boolean", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
    }
    if (q.type === "choice") {
      return {
        type: "choice",
        instructions: q.instructions,
        // The gateway wants a description per option; fall back to the label.
        criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, v || k])),
      };
    }
    return { type: "score", instructions: q.instructions, criteria: q.criteria };
  };

  return {
    name: "vercel",
    defaultModel,
    async judge({ state, questions, model }) {
      const started = Date.now();
      const res = await postJson(
        "vercel",
        `${origin(baseUrl)}/v4/ai/evaluation-model`,
        {
          Authorization: `Bearer ${apiKey}`,
          "ai-gateway-protocol-version": "0.0.1",
          "ai-evaluation-model-specification-version": "4",
          "ai-model-id": model ?? defaultModel,
        },
        { state, questions: Object.fromEntries(questions.map((q) => [q.id, toGateway(q)])) },
        http,
      );

      const reported = res.providerMetadata?.typesafe?.confidence ?? {};
      // Same rule as parseNative: a bad answer costs its own question, not the batch.
      const answers = questions.map((q) => {
        const a = res.answers?.[q.id];
        if (!a) return { error: `response is missing an answer for "${q.id}"` };
        if (q.type === "noul") {
          if (typeof a.probability !== "number") return { error: `answer "${q.id}" has no probability` };
          return { answer: a.probability };
        }
        const value = q.type === "choice" ? a.choice : a.score;
        if (value == null) return { error: `answer "${q.id}" has no ${q.type} value` };
        return { answer: value, distribution: a.probabilities, confidence: numberOr(reported[q.id]) };
      });

      return {
        answers,
        model: model ?? defaultModel,
        latencyMs: Date.now() - started,
        usage: { inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens },
      };
    },
  };
}

/**
 * Local mock. Needs no key and reaches no network, so the whole pipeline —
 * screening, escalation, the gate, the CLI — is testable offline. Answers are
 * deterministic for a given question id, never meaningful.
 */
export function mockBackend({ defaultModel = "jev-mock" } = {}) {
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
    return h / 0xffffffff;
  };

  return {
    name: "mock",
    defaultModel,
    async judge({ state, questions, model }) {
      const seed = (q) => hash(`${q.id}:${typeof state === "string" ? state : JSON.stringify(state)}`);
      const answers = questions.map((q) => {
        const r = seed(q);
        if (q.type === "noul") return { answer: Math.round(r * 1000) / 1000 };
        if (q.type === "choice") {
          const options = Object.keys(q.criteria);
          const winner = options[Math.floor(r * options.length) % options.length];
          const rest = (1 - 0.6) / Math.max(1, options.length - 1);
          return {
            answer: winner,
            distribution: Object.fromEntries(options.map((o) => [o, o === winner ? 0.6 : Math.round(rest * 1000) / 1000])),
            confidence: 0.6,
          };
        }
        const levels = q.criteria;
        const idx = Math.min(levels.length - 1, Math.floor(r * levels.length));
        return {
          answer: idx,
          legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
          distribution: Object.fromEntries(levels.map((_, i) => [String(i), i === idx ? 0.6 : Math.round(((1 - 0.6) / (levels.length - 1)) * 1000) / 1000])),
          confidence: 0.6,
        };
      });
      return { answers, model: model ?? defaultModel, latencyMs: 0, usage: {} };
    },
    async models() {
      return [{ name: defaultModel, description: "Local mock — no network, deterministic, meaningless answers." }];
    },
  };
}

export const BACKENDS = { typesafe: typesafeBackend, openrouter: openrouterBackend, vercel: vercelBackend, mock: mockBackend };
