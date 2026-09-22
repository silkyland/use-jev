/**
 * Resolves which provider to call and with which credential, from CLI flags,
 * the environment, or ~/.use-jev/config.json. Nothing here logs or returns a key.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKENDS } from "./backends.mjs";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".use-jev", "config.json");

/** Provider -> the env var it reads and the config-file field it falls back to. */
const CREDENTIALS = {
  typesafe: { env: ["TYPESAFE_API_KEY", "JEV_API_KEY"], field: "apiKey", console: "https://console.typesafe.ai" },
  openrouter: { env: ["OPENROUTER_API_KEY"], field: "openrouterApiKey", console: "https://openrouter.ai/keys" },
  vercel: { env: ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_KEY"], field: "vercelApiKey", console: "https://vercel.com/ai-gateway" },
  mock: { env: [], field: null, console: null },
};

/** Preference order when no backend is named: whichever key exists first. */
const AUTO_ORDER = ["typesafe", "openrouter", "vercel"];

export function parseArgs(argv) {
  const out = { _: [] };
  const flags = {
    "--api-key": "apiKey",
    "--backend": "backend",
    "--model": "model",
    "--base-url": "baseUrl",
    "--config": "config",
    "--threshold": "threshold",
    "--state-file": "stateFile",
    "--questions-file": "questionsFile",
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const [flag, inline] = token.split("=", 2);
    if (flag === "--json") {
      out.json = true;
      continue;
    }
    const key = flags[flag];
    if (!key) continue;
    out[key] = inline ?? argv[++i];
  }
  return out;
}

function readConfigFile(path) {
  try {
    return { data: JSON.parse(readFileSync(path, "utf8")), loaded: true };
  } catch (err) {
    if (err.code !== "ENOENT") process.stderr.write(`use-jev: ignoring ${path}: ${err.message}\n`);
    return { data: {}, loaded: false };
  }
}

const firstNonEmpty = (pairs) =>
  pairs.find(([, value]) => typeof value === "string" && value.trim() !== "");

/**
 * Returns the resolved configuration plus a ready backend, or `backend: null`
 * with a `problem` explaining what is missing. Never throws on a missing key —
 * callers surface `problem` so the agent gets an actionable message.
 */
export function resolve(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const configPath = args.config ?? env.USE_JEV_CONFIG ?? DEFAULT_CONFIG_PATH;
  const { data: file, loaded } = readConfigFile(configPath);

  const requested = (args.backend ?? env.JEV_BACKEND ?? file.backend ?? "auto").toLowerCase();

  /** Finds a credential for one provider and says where it came from. */
  const credentialFor = (name) => {
    const spec = CREDENTIALS[name];
    if (!spec) return null;
    if (name === "mock") return { key: null, source: "n/a (mock)" };
    const hit = firstNonEmpty([
      ...(name === "typesafe" ? [["--api-key", args.apiKey]] : []),
      ...spec.env.map((v) => [v, env[v]]),
      [loaded ? configPath : configPath, spec.field ? file[spec.field] : undefined],
    ]);
    return hit ? { key: hit[1].trim(), source: hit[0] } : null;
  };

  let chosen = requested;
  let credential = null;

  if (requested === "auto") {
    for (const name of AUTO_ORDER) {
      const found = credentialFor(name);
      if (found) {
        chosen = name;
        credential = found;
        break;
      }
    }
    if (!credential) {
      return {
        ...base(configPath, loaded, args, file, env),
        requestedBackend: "auto",
        backendName: null,
        backend: null,
        problem:
          "No credential found for any provider. Set one of TYPESAFE_API_KEY, OPENROUTER_API_KEY or " +
          `AI_GATEWAY_API_KEY, or write apiKey / openrouterApiKey / vercelApiKey to ${configPath}. ` +
          "For a keyless dry run set JEV_BACKEND=mock.",
      };
    }
  } else {
    if (!BACKENDS[chosen]) {
      return {
        ...base(configPath, loaded, args, file, env),
        requestedBackend: requested,
        backendName: null,
        backend: null,
        problem: `Unknown backend "${requested}". Choose typesafe, openrouter, vercel, mock or auto.`,
      };
    }
    credential = credentialFor(chosen);
    if (!credential && chosen !== "mock") {
      const spec = CREDENTIALS[chosen];
      return {
        ...base(configPath, loaded, args, file, env),
        requestedBackend: requested,
        backendName: chosen,
        backend: null,
        problem:
          `Backend "${chosen}" is selected but has no credential. Set ${spec.env.join(" or ")}, ` +
          `or write "${spec.field}" to ${configPath}. Keys: ${spec.console}`,
      };
    }
  }

  const model = args.model ?? env.JEV_MODEL ?? file.model;
  const backend = BACKENDS[chosen]({
    apiKey: credential?.key,
    ...(args.baseUrl ?? file.baseUrl ? { baseUrl: args.baseUrl ?? file.baseUrl } : {}),
    ...(model ? { defaultModel: model } : {}),
  });

  return {
    ...base(configPath, loaded, args, file, env),
    requestedBackend: requested,
    backendName: chosen,
    backend,
    credentialSource: credential?.source ?? "n/a (mock)",
    defaultModel: backend.defaultModel,
    problem: null,
  };
}

function base(configPath, loaded, args, file, env) {
  const threshold = Number(args.threshold ?? env.JEV_CONFIDENCE_THRESHOLD ?? file.confidenceThreshold);
  return {
    args,
    configPath,
    configLoaded: loaded,
    confidenceThreshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : undefined,
    maxStateTokens: Number(file.maxStateTokens) || undefined,
  };
}

/** The providers this machine could reach right now, for `doctor` and `jev_status`. */
export function availableProviders(env = process.env, configPath = DEFAULT_CONFIG_PATH) {
  const { data: file } = readConfigFile(configPath);
  return Object.entries(CREDENTIALS).map(([name, spec]) => ({
    backend: name,
    configured:
      name === "mock" ||
      spec.env.some((v) => (env[v] ?? "").trim() !== "") ||
      (spec.field ? (file[spec.field] ?? "").trim?.() !== "" && file[spec.field] !== "PUT-YOUR-TYPESAFE-KEY-HERE" : false),
    reads: name === "mock" ? ["(nothing)"] : [...spec.env, `${configPath}#${spec.field}`],
  }));
}
