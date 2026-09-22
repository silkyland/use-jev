#!/usr/bin/env node
/**
 * use-jev CLI.
 *
 *   use-jev install [--dry-run]          wire every detected agent; writes no credential
 *   use-jev uninstall [--dry-run]        undo that
 *   use-jev hook-config                  print the PreToolUse fragment for THIS install
 *   use-jev doctor                       what is configured, and does it work
 *   use-jev judge  --questions-file q.json [--state-file s.txt]
 *                                        judge a file; the data never enters an agent's context
 *   use-jev gate --hook                  PreToolUse hook: risk-check every tool call, 0 LLM tokens
 *   use-jev serve                        run the MCP server on stdio
 *
 * The hook contract and the tighten-only / fail-open rules follow jev-use
 * (MIT, github.com/shitianfang/jev-use).
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { availableProviders, resolve } from "./lib/config.mjs";
import { gate, judge } from "./lib/judge.mjs";
import { ESTIMATED_CONFIDENCE_THRESHOLD, REPORTED_CONFIDENCE_THRESHOLD } from "./lib/protocol.mjs";
import { AGENTS, detectedSkillDirs, hookFragment, install } from "./lib/install.mjs";
import { NAME, PACKAGE_ROOT, SERVER_ENTRY, VERSION, launchCommand, tildify } from "./lib/paths.mjs";

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("--")) ?? "doctor";
const config = resolve(argv, process.env);
const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

const readStdin = async () => {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

/* -------------------------------------------------------------------- doctor */

async function doctor() {
  const providers = availableProviders(process.env, config.configPath);
  console.log(`${NAME} ${VERSION} doctor\n`);
  console.log(`  package           ${tildify(PACKAGE_ROOT)}`);
  console.log(`  node              ${process.execPath}`);
  console.log(`  config file       ${tildify(config.configPath)}${config.configLoaded ? "" : "  (not found)"}`);
  console.log(`  backend requested ${config.requestedBackend}`);
  console.log(`  backend active    ${config.backendName ?? "NONE"}`);
  if (config.backend) {
    console.log(`  credential from   ${config.credentialSource}`);
    console.log(`  default model     ${config.defaultModel}`);
  }
  console.log(
    `  thresholds        reported ${REPORTED_CONFIDENCE_THRESHOLD} / estimated ${ESTIMATED_CONFIDENCE_THRESHOLD}` +
      `${config.confidenceThreshold != null ? `  (overridden to ${config.confidenceThreshold})` : ""}`,
  );

  console.log(`\n  providers`);
  for (const p of providers) {
    console.log(`    ${p.configured ? "✓" : "·"} ${p.backend.padEnd(11)} reads ${p.reads.map(tildify).join(", ")}`);
  }

  const plan = install({ dryRun: true });
  console.log(`\n  agents`);
  for (const r of plan.results) {
    const wired = ["current", "would-update"].includes(r.mcp.status);
    const mark = r.mcp.status === "not-installed" ? "·" : wired ? "✓" : "!";
    const note = r.mcp.status === "not-installed" ? "not installed" : wired ? "wired" : `run \`install\` (${r.mcp.status})`;
    console.log(`    ${mark} ${r.agent.padEnd(14)} ${note}${r.verified === false ? "  [shape unverified]" : ""}`);
  }
  console.log(`    ${["current", "would-relink"].includes(plan.shared.status) ? "✓" : "!"} shared skill  ${tildify(plan.shared.path ?? "")} (${plan.shared.status})`);
  for (const d of detectedSkillDirs()) console.log(`      · ${tildify(d.dir)} — ${d.entries} skills`);

  if (!config.backend) {
    console.log(`\n  PROBLEM  ${config.problem}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n  live check        `);
  const probe = await judge(config.backend, {
    state: "ok",
    questions: { probe: { type: "noul", instructions: "Is this string non-empty?" } },
  });
  const verdict = probe.verdicts[0];
  if (verdict?.reason === "unreachable") {
    console.log(`FAILED — ${probe.error ?? verdict.hint}`);
    process.exitCode = 1;
  } else {
    console.log(`ok — ${probe.model} answered in ${probe.latencyMs ?? 0}ms (noul=${verdict.answer})`);
  }

  console.log(
    `\n  note              an MCP tool is never auto-allowed by a permission mode. For headless runs add\n` +
      `                    {"permissions":{"allow":["mcp__use-jev"]}} to your agent's settings.\n` +
      `                    Pre-authorizing a tool that sends your state to a third party is your call.\n`,
  );
}

/* --------------------------------------------------------------------- judge */

async function judgeFile() {
  if (!config.backend) {
    process.stderr.write(`use-jev: ${config.problem}\n`);
    process.exit(1);
  }
  const questionsPath = config.args.questionsFile;
  if (!questionsPath) {
    process.stderr.write(
      "use-jev judge: --questions-file <file.json> is required (a map of question id -> question).\n" +
        "State comes from --state-file <file>, or stdin when that is omitted.\n",
    );
    process.exit(2);
  }

  const questions = JSON.parse(readFileSync(questionsPath, "utf8"));
  const raw = config.args.stateFile ? readFileSync(config.args.stateFile, "utf8") : await readStdin();
  if (!raw.trim()) {
    process.stderr.write("use-jev judge: no state — pass --state-file or pipe it on stdin.\n");
    process.exit(2);
  }
  // A state file holding JSON is passed through as structure; anything else is text.
  let state = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") state = parsed;
  } catch {
    /* plain text is a perfectly good state */
  }

  const result = await judge(config.backend, {
    state,
    questions,
    model: config.args.model,
    confidenceThreshold: config.confidenceThreshold,
    maxStateTokens: config.maxStateTokens,
  });
  out(result);
  process.exitCode = result.escalated ? 3 : 0; // 3 = something needs a human or an LLM
}

/* ---------------------------------------------------------------------- gate */

/**
 * PreToolUse hook. Reads the hook event on stdin and only ever TIGHTENS:
 *   deny -> permissionDecision "deny"
 *   ask  -> permissionDecision "ask"
 *   allow -> no output at all, so the normal permission flow decides.
 * Every failure is fail-open (exit 0, no output): a judgment sidecar being down
 * must never block the agent.
 */
async function hookGate() {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    process.stderr.write("use-jev gate: stdin was not hook-event JSON — failing open.\n");
    return;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    process.stderr.write("use-jev gate: stdin JSON was not a hook event object — failing open.\n");
    return;
  }
  if (!config.backend) {
    process.stderr.write(`use-jev gate: no backend (${config.problem}) — failing open.\n`);
    return;
  }

  try {
    const tool = event.tool_name ?? event.toolName ?? "unknown";
    const input = event.tool_input ?? event.toolInput ?? {};
    // A hook event carries almost no context, so let the operator add the rest.
    const extra = process.env.JEV_GATE_STATE?.trim();
    const state = [
      `cwd: ${event.cwd ?? process.cwd()}`,
      event.permission_mode ? `permission mode: ${event.permission_mode}` : null,
      extra ? `operator note: ${extra}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const threshold = Number(process.env.JEV_GATE_THRESHOLD);
    const result = await gate(config.backend, {
      state,
      tool,
      input: typeof input === "string" ? input : JSON.stringify(input),
      confidenceThreshold: Number.isFinite(threshold) ? threshold : config.confidenceThreshold,
    });

    if (result.decision === "allow") return; // stay silent; never loosen
    out({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.decision === "deny" ? "deny" : "ask",
        permissionDecisionReason:
          result.decision === "deny"
            ? `Jev gate: denied (confidence ${result.confidence}, ${result.confidenceFrom}).`
            : `Jev gate: not confident this is safe (${result.reason ?? "unsure"}) — please review.`,
      },
    });
  } catch (e) {
    process.stderr.write(`use-jev gate: fail-open (${e.message})\n`);
  }
}

/* ------------------------------------------------------------------- install */

const LABEL = {
  added: "added", updated: "updated", removed: "removed", current: "already current",
  linked: "linked", relinked: "relinked", absent: "nothing to remove",
  "not-installed": "agent not installed", skipped: "skipped", manual: "needs a manual edit",
  "via-shared-store": "reads the shared skill store",
};

function report({ results, shared, dryRun, remove }) {
  const verb = remove ? "uninstall" : "install";
  console.log(`\n${NAME} ${VERSION} — ${dryRun ? `${verb} plan (nothing written)` : verb}\n`);
  const { command, args } = launchCommand();
  console.log(`  agents launch:  ${[command, ...args].join(" ")}\n`);

  for (const r of results) {
    const mcp = LABEL[r.mcp.status] ?? r.mcp.status;
    const skill = LABEL[r.skill.status] ?? r.skill.status;
    console.log(`  ${r.agent.padEnd(14)} mcp: ${mcp.padEnd(24)} skill: ${skill}`);
    if (r.mcp.detail) console.log(`  ${"".padEnd(14)}   ${r.mcp.detail}`);
    if (r.skill.detail) console.log(`  ${"".padEnd(14)}   ${r.skill.detail}`);
    if (r.verified === false && r.mcp.status !== "not-installed") {
      console.log(`  ${"".padEnd(14)}   note: this agent's config shape is unverified — check it opened the server`);
    }
    if (r.mcp.backup) console.log(`  ${"".padEnd(14)}   backup: ${tildify(r.mcp.backup)}`);
  }
  console.log(`\n  shared skill store  ${LABEL[shared.status] ?? shared.status}${shared.path ? ` — ${tildify(shared.path)}` : ""}`);

  if (!remove) {
    console.log(
      `\n  No credential was written. Set one of TYPESAFE_API_KEY / OPENROUTER_API_KEY /\n` +
        `  AI_GATEWAY_API_KEY, or fill ${tildify(config.configPath)}. Then: ${NAME} doctor\n` +
        `\n  Headless runs also need a permission rule: {"permissions":{"allow":["mcp__${NAME}"]}}\n`,
    );
  } else {
    console.log("");
  }
}

const onlyFlag = () => {
  const i = argv.indexOf("--agent");
  return i === -1 ? null : argv[i + 1]?.split(",");
};

async function installCmd() {
  const only = onlyFlag();
  if (only) {
    const unknown = only.filter((id) => !AGENTS.some((a) => a.id === id));
    if (unknown.length) {
      process.stderr.write(`${NAME}: unknown agent(s) ${unknown.join(", ")}. Known: ${AGENTS.map((a) => a.id).join(", ")}\n`);
      process.exit(2);
    }
  }
  report(install({ dryRun: argv.includes("--dry-run"), only, skills: !argv.includes("--no-skills") }));
}

async function uninstallCmd() {
  report(install({ dryRun: argv.includes("--dry-run"), remove: true, only: onlyFlag() }));
}

async function hookConfig() {
  out(hookFragment());
  process.stderr.write(
    `\n# Merge the "hooks" key above into your agent's settings.json.\n` +
      `# It only ever TIGHTENS (deny -> deny, unsure -> ask, allow -> silent) and fails open.\n` +
      `# It is opt-in because it sends a description of every matched tool call to your provider.\n` +
      `# Tune with JEV_GATE_THRESHOLD; add context with JEV_GATE_STATE.\n`,
  );
}

/* --------------------------------------------------------------------- serve */

function serve() {
  const child = spawn(process.execPath, [SERVER_ENTRY, ...argv.filter((a) => a !== "serve")], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/* ------------------------------------------------------------------ dispatch */

const commands = {
  install: installCmd,
  uninstall: uninstallCmd,
  "hook-config": hookConfig,
  doctor,
  judge: judgeFile,
  gate: hookGate,
  hook: hookGate,
  serve,
};
const run = commands[command];
if (!run) {
  process.stderr.write(
    `${NAME} ${VERSION}\n\nUnknown command "${command}". Available:\n` +
      `  install [--dry-run] [--agent a,b] [--no-skills]\n  uninstall [--dry-run]\n  hook-config\n` +
      `  doctor\n  judge --questions-file q.json [--state-file f]\n  gate --hook\n  serve\n`,
  );
  process.exit(2);
}
await run();
