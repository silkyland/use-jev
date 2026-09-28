#!/usr/bin/env node
/**
 * Smoke test. Four phases, and the first three need no credential at all
 * because the mock backend runs the whole pipeline locally:
 *
 *   1. mock backend over MCP  — tools, verdicts, escalation, screening, gate, route
 *   2. no backend             — the configuration problem is actionable
 *   3. CLI                    — doctor, judge, and the PreToolUse hook contract
 *  3b. paths and the installer
 *  3c. regressions            — the defects fixed after 0.3.1, one check per defect
 *   4. your real config       — a live call, or a clear skip
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { existsSync as exists, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir as homedirLocal, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "index.mjs");
const cli = join(here, "cli.mjs");
const run = promisify(execFile);
const tildifyLocal = (p) => (p.startsWith(homedirLocal()) ? `~${p.slice(homedirLocal().length)}` : p);

let failures = 0;
const check = (label, passed, detail) => {
  if (!passed) failures++;
  console.log(`${passed ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};
const text = (r) => r.content.map((c) => c.text).join("\n");
const parse = (r) => JSON.parse(text(r));

/** A keyless environment, so nothing on this machine leaks into a phase. */
const bare = { ...process.env };
for (const k of [
  "TYPESAFE_API_KEY",
  "JEV_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "JEV_BACKEND",
  "JEV_CONFIDENCE_THRESHOLD",
  "JEV_MAX_STATE_TOKENS",
]) {
  delete bare[k];
}
const NOWHERE = "/nonexistent/use-jev.json";

async function open(args, env = bare) {
  const client = new Client({ name: "use-jev-smoke", version: "0.2.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, ...args], env, stderr: "pipe" }));
  return client;
}

const TICKET = "Payouts have failed for three days and nobody has replied to my emails. This is costing us money.";

console.log("\nuse-jev smoke test");

/* ------------------------------------------------- 1. mock backend over MCP */

console.log("\n[1] mock backend — the full pipeline, no credential");
{
  const client = await open(["--backend", "mock", "--config", NOWHERE]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check("tools/list", tools.length === 9, `${tools.length} tools: ${names.join(", ")}`);
  check("every tool advertises an input schema", tools.every((t) => t.inputSchema?.type === "object"));

  const status = parse(await client.callTool({ name: "jev_status", arguments: {} }));
  check("jev_status reports the mock backend", status.active_backend === "mock", `credential=${status.credential_source}`);
  check(
    "jev_status lists every provider and what it reads",
    Array.isArray(status.providers) && status.providers.length === 4,
    status.providers?.map((p) => `${p.backend}:${p.configured ? "y" : "n"}`).join(" "),
  );
  check("jev_status never echoes a key", !JSON.stringify(status).match(/sk-|apikey_/i));

  const batch = parse(
    await client.callTool({
      name: "jev_ask",
      arguments: {
        state: TICKET,
        questions: {
          urgent: { type: "noul", instructions: "Does this convey urgency?" },
          team: {
            type: "choice",
            instructions: "Which team should handle this?",
            criteria: { billing: "Payments and payouts", technical: "Bugs and outages", sales: "Pricing" },
          },
          severity: {
            type: "score",
            instructions: "How severe is the customer impact?",
            criteria: ["No money at stake", "Money delayed", "Money lost and trust broken"],
          },
        },
      },
    }),
  );
  check("jev_ask answers 3 questions in 1 call", batch.verdicts?.length === 3, `backend=${batch.backend}`);
  check(
    "each verdict carries answer + confidence + source",
    batch.verdicts.every((v) => v.answer != null && typeof v.confidence === "number" && v.confidenceFrom),
    batch.verdicts.map((v) => `${v.id}=${v.answer}`).join(" "),
  );
  check(
    "noul confidence is estimated, choice/score report theirs",
    batch.verdicts.find((v) => v.id === "urgent").confidenceFrom === "estimated" &&
      batch.verdicts.find((v) => v.id === "team").confidenceFrom === "reported",
  );
  check("the batch exposes a single escalated flag", typeof batch.escalated === "boolean");
  check("score verdicts echo a legend", Boolean(batch.verdicts.find((v) => v.id === "severity").legend));

  // The mock reports 0.6, so a 0.9 threshold must escalate while keeping the answer.
  const strict = parse(
    await client.callTool({
      name: "jev_choice",
      arguments: {
        state: TICKET,
        instructions: "Which team should handle this?",
        options: { billing: "Payments", technical: "Outages" },
        threshold: 0.9,
      },
    }),
  );
  check("a threshold above the confidence escalates", strict.escalate === true && strict.reason === "unsure");
  check("an escalated verdict still carries its answer as a prior", strict.answer != null, `answer=${strict.answer}`);
  check("escalation comes with a usable hint", typeof strict.hint === "string" && strict.hint.length > 20);

  const oversized = parse(
    await client.callTool({
      name: "jev_noul",
      arguments: { state: "x".repeat(200_000), question: "Is this long?" },
    }),
  );
  check("an oversized state is handed back before any call", oversized.reason === "oversized" && oversized.answer === null);

  const malformed = parse(
    await client.callTool({
      name: "jev_ask",
      arguments: {
        state: "hi",
        questions: {
          good: { type: "noul", instructions: "Is this short?" },
          bad: { type: "score", instructions: "Rate it", criteria: ["only one level"] },
        },
      },
    }),
  );
  const badVerdict = malformed.verdicts.find((v) => v.id === "bad");
  const goodVerdict = malformed.verdicts.find((v) => v.id === "good");
  check("a malformed question is handed back as open_ended", badVerdict?.reason === "open_ended", badVerdict?.hint);
  check("its valid siblings are still answered", goodVerdict?.answer != null);

  const gateDeny = parse(
    await client.callTool({
      name: "jev_gate",
      arguments: { state: "Routine cleanup task.", tool: "Bash", input: "rm -rf / --no-preserve-root" },
    }),
  );
  check("jev_gate returns a decision", ["allow", "deny", "ask"].includes(gateDeny.decision), `decision=${gateDeny.decision}`);

  const gateUnsure = parse(
    await client.callTool({
      name: "jev_gate",
      arguments: { state: "Routine task.", tool: "Bash", input: "ls", threshold: 0.99 },
    }),
  );
  check("an unsure gate becomes ask, never allow", gateUnsure.decision === "ask", `hint=${(gateUnsure.hint ?? "").slice(0, 40)}`);

  const writing = parse(
    await client.callTool({ name: "jev_route", arguments: { produces_content: true, enumerable: true } }),
  );
  const openEnded = parse(
    await client.callTool({ name: "jev_route", arguments: { produces_content: false, enumerable: false } }),
  );
  const forJev = parse(
    await client.callTool({ name: "jev_route", arguments: { produces_content: false, enumerable: true } }),
  );
  check(
    "jev_route sends writing and open-ended steps to the LLM, the rest to Jev",
    writing.to === "llm" && writing.reason === "writing" && openEnded.reason === "open_ended" && forJev.to === "jev",
  );

  const models = parse(await client.callTool({ name: "jev_models", arguments: {} }));
  check("jev_models works on the mock", models.backend === "mock" && models.models.length > 0);

  const howto = await client.callTool({ name: "jev_howto", arguments: {} });
  check("jev_howto explains the rate-not-token point", text(howto).includes("RATE win"));

  await client.close();
}

/* --------------------------------------------------------- 2. no backend */

console.log("\n[2] no credential for any provider");
{
  const client = await open(["--config", NOWHERE]);
  const status = parse(await client.callTool({ name: "jev_status", arguments: {} }));
  check("jev_status names the problem", typeof status.problem === "string" && status.problem.includes("No credential"));
  check("it still lists what each provider reads", status.providers.every((p) => p.reads.length > 0));

  const call = await client.callTool({ name: "jev_noul", arguments: { state: "hi", question: "ok?" } });
  check(
    "a judging call errors with the fix, not a crash",
    call.isError === true && /JEV_BACKEND=mock/.test(text(call)),
    text(call).slice(0, 70),
  );

  const route = await client.callTool({ name: "jev_route", arguments: { produces_content: true, enumerable: true } });
  check("local tools still work without any credential", route.isError !== true);
  await client.close();
}

/* ---------------------------------------------------------------- 3. CLI */

console.log("\n[3] CLI");
{
  const dir = mkdtempSync(join(tmpdir(), "use-jev-smoke-"));
  const questionsPath = join(dir, "questions.json");
  const statePath = join(dir, "state.txt");
  writeFileSync(
    questionsPath,
    JSON.stringify({
      failed: { type: "noul", instructions: "Did the run fail?" },
      next: {
        type: "choice",
        instructions: "What should happen next?",
        criteria: { retry: "Looks flaky", investigate: "A real failure", ignore: "Not important" },
      },
    }),
  );
  writeFileSync(statePath, "npm test — 3 passing, 1 failing: timeout after 5000ms in auth.spec.ts");

  const mockEnv = { ...bare, JEV_BACKEND: "mock", USE_JEV_CONFIG: NOWHERE };

  const doctor = await run(process.execPath, [cli, "doctor"], { env: mockEnv });
  check(
    "doctor reports the active backend and a live check",
    /backend active\s+mock/.test(doctor.stdout) && /live check\s+ok/.test(doctor.stdout),
  );
  check("doctor lists all four providers", (doctor.stdout.match(/reads /g) ?? []).length === 4);
  check("doctor warns that MCP tools are not auto-allowed", /permissions/.test(doctor.stdout));

  const judged = await run(process.execPath, [cli, "judge", "--questions-file", questionsPath, "--state-file", statePath], {
    env: mockEnv,
  }).catch((e) => e); // exit 3 when something escalated
  const result = JSON.parse(judged.stdout);
  check("judge reads a file and prints verdicts", result.verdicts?.length === 2, `backend=${result.backend}`);
  check(
    "judge exits 3 when a verdict escalated, 0 otherwise",
    result.escalated ? judged.code === 3 : (judged.code ?? 0) === 0,
    `escalated=${result.escalated} exit=${judged.code ?? 0}`,
  );

  const piped = await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cli, "judge", "--questions-file", questionsPath],
      { env: mockEnv },
      (error, stdout) => resolve({ error, stdout }),
    );
    child.stdin.end("npm test — everything passing");
  });
  check("judge accepts state on stdin", JSON.parse(piped.stdout).verdicts?.length === 2);

  /** The hook must emit deny/ask, or nothing at all for an allow. */
  const hookRaw = async (env, raw) =>
    new Promise((resolve) => {
      const child = execFile(process.execPath, [cli, "gate", "--hook"], { env }, (error, stdout, stderr) =>
        resolve({ error, stdout, stderr }),
      );
      child.stdin.end(raw);
    });
  const hook = (env, input) => hookRaw(env, JSON.stringify(input));

  const askHook = await hook(
    { ...mockEnv, JEV_GATE_THRESHOLD: "0.99" },
    { tool_name: "Bash", tool_input: { command: "rm -rf build" }, cwd: "/tmp", permission_mode: "default" },
  );
  const askOut = JSON.parse(askHook.stdout);
  check(
    "hook emits the PreToolUse permission shape",
    askOut.hookSpecificOutput?.hookEventName === "PreToolUse" &&
      ["deny", "ask"].includes(askOut.hookSpecificOutput.permissionDecision) &&
      typeof askOut.hookSpecificOutput.permissionDecisionReason === "string",
    askOut.hookSpecificOutput?.permissionDecision,
  );

  // The mock's choice is deterministic per input, so probe a spread and assert
  // the invariant that actually matters: the gate can only ever tighten.
  const probes = await Promise.all(
    ["ls", "cat README.md", "git status", "echo hi", "pwd", "node -v"].map((command) =>
      hook({ ...mockEnv, JEV_GATE_THRESHOLD: "0" }, { tool_name: "Bash", tool_input: { command }, cwd: "/tmp" }),
    ),
  );
  const decisions = probes.map((r) => (r.stdout.trim() === "" ? "silent" : JSON.parse(r.stdout).hookSpecificOutput.permissionDecision));
  check("hook never emits an allow — it can only tighten", !decisions.includes("allow"), decisions.join(", "));
  check("hook stays silent when the decision is allow", decisions.includes("silent"), decisions.join(", "));

  const brokenHook = await hookRaw(mockEnv, "not-an-event{{{");
  check("hook fails open on unparseable input", brokenHook.stdout.trim() === "" && !brokenHook.error, brokenHook.stderr.trim());

  const scalarHook = await hookRaw(mockEnv, '"a json string, but not an event"');
  check("hook fails open on JSON that is not an event object", scalarHook.stdout.trim() === "" && !scalarHook.error);

  const keylessHook = await hook({ ...bare, USE_JEV_CONFIG: NOWHERE }, { tool_name: "Bash", tool_input: { command: "ls" } });
  check(
    "hook fails open when no provider is configured",
    keylessHook.stdout.trim() === "" && /fail-open|no backend/.test(keylessHook.stderr),
  );
}

/* ------------------------------------------- 3b. paths and the installer */

console.log("\n[3b] path resolution and the installer");
{
  const paths = await import("./lib/paths.mjs");
  check("PACKAGE_ROOT points at this package", exists(join(paths.PACKAGE_ROOT, "package.json")), tildifyLocal(paths.PACKAGE_ROOT));
  check("SERVER_ENTRY and SKILL_DIR exist", exists(paths.SERVER_ENTRY) && exists(join(paths.SKILL_DIR, "SKILL.md")));
  check(
    "NODE_BIN is absolute and matches the running version",
    paths.NODE_BIN.startsWith("/") &&
      (await run(paths.NODE_BIN, ["--version"])).stdout.trim() === process.version,
    tildifyLocal(paths.NODE_BIN),
  );
  // The fallback to process.execPath is the documented behaviour when no node on
  // PATH matches the running version, so a version-pinned path is only a defect
  // when a stable alternative was actually available.
  const versionPinned = /\/\d+\.\d+\.\d+/.test(paths.NODE_BIN);
  check(
    "NODE_BIN is not version-pinned unless that is the documented fallback",
    !versionPinned || paths.NODE_BIN === process.execPath,
    tildifyLocal(paths.NODE_BIN),
  );

  // A dry run must report a plan and touch nothing.
  const before = readFileSync(join(homedirLocal(), ".claude.json"), "utf8");
  const plan = await run(process.execPath, [cli, "install", "--dry-run"]);
  check("install --dry-run reports a plan", /install plan \(nothing written\)/.test(plan.stdout));
  check("install --dry-run lists every known agent", (plan.stdout.match(/mcp:/g) ?? []).length >= 6);
  check("install --dry-run never writes a credential", !/API_KEY"\s*:/.test(plan.stdout));
  check(
    "install --dry-run leaves configs untouched",
    readFileSync(join(homedirLocal(), ".claude.json"), "utf8") === before,
  );

  const fragment = JSON.parse((await run(process.execPath, [cli, "hook-config"])).stdout);
  const hookCmd = fragment.hooks.PreToolUse[0].hooks[0].command;
  check("hook-config emits the PreToolUse shape", Array.isArray(fragment.hooks?.PreToolUse) && /gate --hook$/.test(hookCmd));
  check("hook-config resolves paths instead of relying on PATH", hookCmd.startsWith("/"), hookCmd);

  // The skill's frontmatter must be valid YAML. A plain scalar containing ": "
  // parses as a nested mapping, which silently made the skills CLI reject the
  // whole file while Claude Code's looser parser still accepted it.
  const skillText = readFileSync(join(paths.SKILL_DIR, "SKILL.md"), "utf8");
  const fm = skillText.match(/^---\n([\s\S]*?)\n---\n/);
  check("SKILL.md has frontmatter", Boolean(fm));
  const descLine = fm?.[1].split("\n").find((l) => l.startsWith("description:"));
  const folded = /^description:\s*[>|][-+]?\s*$/.test(descLine ?? "");
  const inlineValue = (descLine ?? "").slice("description:".length);
  check(
    "SKILL.md description is a block scalar, or a plain one with no \": \"",
    folded || !inlineValue.includes(": "),
    folded ? "folded block scalar" : `inline: ${inlineValue.trim().slice(0, 40)}`,
  );
  check("SKILL.md declares a name", /^name:\s*\S+/m.test(fm?.[1] ?? ""));

  // The Agent Skills spec caps name at 64 and description at 1024 characters.
  // Over-length frontmatter is rejected or silently truncated, and the description
  // is the only thing an agent matches a request against — so it must fit.
  const skillName = (fm?.[1].match(/^name:\s*(.+)$/m)?.[1] ?? "").trim();
  const skillDesc = (fm?.[1] ?? "")
    .split("\n")
    .filter((l) => l && !l.startsWith("name:"))
    .join(" ")
    .replace(/^description:\s*[>|][-+]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  check("SKILL.md name fits the 64-character limit", skillName.length > 0 && skillName.length <= 64, `${skillName.length} chars`);
  check(
    "SKILL.md description fits the 1024-character limit",
    skillDesc.length > 0 && skillDesc.length <= 1024,
    `${skillDesc.length} chars`,
  );

  const bad = await run(process.execPath, [cli, "install", "--agent", "not-an-agent"]).catch((e) => e);
  check("install rejects an unknown --agent", bad.code === 2 && /unknown agent/.test(bad.stderr ?? ""));

  const usage = await run(process.execPath, [cli, "nonsense-command"]).catch((e) => e);
  check("an unknown command prints usage and exits 2", usage.code === 2 && /install \[--dry-run\]/.test(usage.stderr ?? ""));
}

/* ------------------------------------------------------- 3c. the four fixes */

console.log("\n[3c] regressions — defects fixed after 0.3.1");
{
  const { estimateTokens, NO_JUDGMENT_REASONS } = await import("./lib/protocol.mjs");
  const { resolve } = await import("./lib/config.mjs");
  const { gate, judge: judgeBatch } = await import("./lib/judge.mjs");

  // The shipped config.example.json carries `confidenceThreshold: null`. Number(null)
  // is 0, which reads as "threshold 0" — i.e. escalation silently switched off.
  const cfgDir = mkdtempSync(join(tmpdir(), "use-jev-regress-"));
  const cfg = join(cfgDir, "config.json");
  writeFileSync(cfg, JSON.stringify({ backend: "mock", confidenceThreshold: null }));
  const nullThreshold = resolve(["--config", cfg], { ...bare, JEV_BACKEND: "mock" });
  check(
    "a null confidenceThreshold stays absent instead of becoming 0",
    nullThreshold.confidenceThreshold === undefined,
    `confidenceThreshold=${nullThreshold.confidenceThreshold}`,
  );
  check(
    "an explicit --threshold 0 is still honoured",
    resolve(["--config", cfg, "--threshold", "0"], bare).confidenceThreshold === 0,
  );

  // Thai and CJK tokenize far denser than the flat characters/3.5 the estimator used.
  const latin = estimateTokens("a".repeat(350));
  const thai = estimateTokens("ก".repeat(350));
  const cjk = estimateTokens("漢".repeat(350));
  check("estimateTokens weights Thai above a flat latin estimate", thai > latin * 2, `latin=${latin} thai=${thai}`);
  check("estimateTokens weights CJK above a flat latin estimate", cjk > latin * 2, `latin=${latin} cjk=${cjk}`);

  // A tool input can be an entire file. The gate must send the shape, not the payload.
  let reachedProvider = "";
  const spy = {
    name: "spy",
    defaultModel: "spy",
    async judge({ state }) {
      reachedProvider = typeof state === "string" ? state : JSON.stringify(state);
      return {
        answers: [{ answer: "allow", distribution: { allow: 1, deny: 0 }, confidence: 1 }],
        model: "spy",
        latencyMs: 0,
        usage: {},
      };
    },
  };
  const gated = await gate(spy, { state: "cwd: /tmp", tool: "Write", input: "x".repeat(200_000) });
  check(
    "the gate clips a huge tool input instead of shipping it whole",
    reachedProvider.length < 6_000,
    `${reachedProvider.length} chars reached the provider`,
  );
  check("the clip says what it dropped", /truncated, 196000 more characters not sent/.test(reachedProvider));
  check("a fully confident gate still resolves to allow", gated.decision === "allow", gated.decision);

  // One unreadable answer must cost its own question, never the batch.
  const partial = {
    name: "partial",
    defaultModel: "partial",
    async judge() {
      return { answers: [{ answer: 0.9 }, { error: 'answer "b" has no noul value' }, { answer: 0.1 }], model: "partial", latencyMs: 0, usage: {} };
    },
  };
  const batch = await judgeBatch(partial, {
    state: "s",
    questions: {
      a: { type: "noul", instructions: "q a" },
      b: { type: "noul", instructions: "q b" },
      c: { type: "noul", instructions: "q c" },
    },
  });
  const byId = Object.fromEntries(batch.verdicts.map((v) => [v.id, v]));
  check("a malformed answer does not abandon the batch", byId.a.answer === 0.9 && byId.c.answer === 0.1, `a=${byId.a.answer} c=${byId.c.answer}`);
  check(
    "only the unreadable question escalates, and says why",
    byId.b.escalate && byId.b.reason === "malformed" && !byId.a.escalate,
    `b.reason=${byId.b.reason}`,
  );
  check(
    "no-judgment reasons are declared as such",
    NO_JUDGMENT_REASONS.has("malformed") && NO_JUDGMENT_REASONS.has("unreachable") && !NO_JUDGMENT_REASONS.has("unsure"),
  );

  // A provider that never answered is not a judgment. The hook must fail OPEN on it —
  // an unanswerable "ask" blocks a headless run, which this hook promises never to do.
  const hookWith = (env, args, raw) =>
    new Promise((done) => {
      const child = execFile(process.execPath, [cli, ...args], { env }, (error, stdout, stderr) => done({ error, stdout, stderr }));
      child.stdin.end(raw);
    });
  const deadHook = await hookWith(
    { ...bare, USE_JEV_CONFIG: NOWHERE, JEV_API_KEY: "x" },
    ["gate", "--hook", "--backend", "typesafe", "--base-url", "http://127.0.0.1:9"],
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/tmp" }),
  );
  check(
    "hook fails open when the provider is unreachable, instead of asking",
    deadHook.stdout.trim() === "" && /failing open/.test(deadHook.stderr),
    (deadHook.stderr ?? "").trim().split("\n")[0],
  );
}

/* -------------------------------------------------------- 4. real config */

console.log("\n[4] your real configuration");
{
  const client = await open([]);
  const status = parse(await client.callTool({ name: "jev_status", arguments: {} }));
  console.log(`  ..   backend: ${status.active_backend ?? "none"} | credential: ${status.credential_source ?? "none"}`);

  if (!status.active_backend || status.active_backend === "mock") {
    console.log(
      `  ..   no real provider configured, so live checks are skipped.\n` +
        `  ..   set TYPESAFE_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY, or fill ${status.config_file}.`,
    );
  } else {
    const verified = parse(await client.callTool({ name: "jev_status", arguments: { verify: true } }));
    check(
      "the configured credential is accepted",
      verified.live_check === "ok",
      verified.live_check === "ok" ? `model ${verified.live_check_model}` : verified.live_check_error,
    );

    if (verified.live_check === "ok") {
      const batch = parse(
        await client.callTool({
          name: "jev_ask",
          arguments: {
            state: TICKET,
            questions: {
              urgent: {
                type: "noul",
                instructions: "Does this convey urgency?",
                criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
              },
              team: {
                type: "choice",
                instructions: "Which team should handle this?",
                criteria: { billing: "Payments, invoicing, payouts", technical: "Bugs, outages", sales: "Pricing" },
              },
            },
          },
        }),
      );
      check(
        "a live batch answers both questions",
        batch.verdicts?.length === 2 && batch.verdicts.every((v) => v.answer != null),
        batch.verdicts?.map((v) => `${v.id}=${v.answer}(${v.confidence})`).join(" ") +
          ` in ${batch.latencyMs}ms, ${batch.usage?.inputTokens} tokens`,
      );
      check("live confidence for a choice is provider-reported", batch.verdicts.find((v) => v.id === "team")?.confidenceFrom === "reported");
    }
  }
  await client.close();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
