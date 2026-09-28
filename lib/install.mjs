/**
 * Wires this package into whichever agents are present on the machine.
 *
 * Every path is resolved at runtime (see lib/paths.mjs); nothing is baked in.
 * A credential is NEVER written: agents get a bare server entry and the key is
 * read from the environment or from the user's own config file at run time.
 */

import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_ENTRY, NAME, SERVER_ENTRY, SKILL_DIR, configHome, exists, launchCommand, tildify } from "./paths.mjs";

/**
 * Known agents and the config shape each one uses.
 *
 * `verified: true` means the shape was read off a real installation. An
 * unverified entry is still written, but reported as such — so a wrong guess is
 * visible instead of silent.
 *
 * `detect` defaults to "the config file exists". An agent that ships without a
 * config file yet (its own directory is there, the file is not) overrides it, or
 * it would be reported as "not installed" on a machine where it plainly is.
 */
export const AGENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    config: () => join(homedir(), ".claude.json"),
    shape: "json-mcpServers",
    skills: () => join(homedir(), ".claude", "skills"),
    verified: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    config: () => join(homedir(), ".cursor", "mcp.json"),
    shape: "json-mcpServers",
    skills: () => join(homedir(), ".cursor", "skills"),
    verified: true,
  },
  {
    id: "codex",
    label: "Codex",
    config: () => join(homedir(), ".codex", "config.toml"),
    shape: "toml-mcpServers",
    skills: () => join(homedir(), ".codex", "skills"),
    verified: true,
  },
  {
    id: "devin",
    label: "Devin",
    config: () => join(homedir(), ".config", "devin", "mcp_config.json"),
    shape: "json-mcpServers",
    skills: () => join(homedir(), ".config", "devin", "skills"),
    verified: true,
  },
  {
    id: "opencode",
    label: "opencode",
    config: () => join(homedir(), ".config", "opencode", "opencode.json"),
    shape: "json-topLevelMcp",
    skills: () => join(homedir(), ".config", "opencode", "skills"),
    verified: true,
  },
  {
    id: "workbuddy",
    label: "WorkBuddy AI",
    config: () => join(homedir(), ".workbuddy-ai", "mcp.json"),
    shape: "json-mcpServers",
    skills: () => join(homedir(), ".workbuddy-ai", "skills"),
    detect: () => exists(join(homedir(), ".workbuddy-ai")),
    verified: false,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    config: () => join(homedir(), ".gemini", "settings.json"),
    shape: "json-mcpServers",
    skills: () => join(homedir(), ".gemini", "skills"),
    verified: false,
  },
];

/** The cross-agent skill store several tools read directly. */
const SHARED_SKILL_STORE = () => join(homedir(), ".agents", "skills");

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

function backup(path, env) {
  const dir = join(configHome(env), "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dir, `${path.split("/").pop()}.${stamp}.bak`);
  copyFileSync(path, dest);
  return dest;
}

/* ---------------------------------------------------------------- MCP entry */

/** The server entry an agent should launch, with paths resolved now. */
function serverEntry(shape) {
  const { command, args } = launchCommand(SERVER_ENTRY);
  if (shape === "json-topLevelMcp") return { type: "local", enabled: true, command: [command, ...args] };
  return { type: "stdio", command, args };
}

function writeJsonMcp(agent, { dryRun, env, remove }) {
  const path = agent.config();
  let current = readJson(path);
  if (!current) {
    // A missing file is a fresh agent, and creating it is the whole point.
    // A file that exists but does not parse is someone else's work — never clobber it.
    if (exists(path)) return { status: "skipped", detail: "config file exists but is not valid JSON" };
    if (remove) return { status: "absent" };
    if (dryRun) return { status: "would-add", path };
    current = {};
  }

  const key = agent.shape === "json-topLevelMcp" ? "mcp" : "mcpServers";
  const existing = current[key]?.[NAME];

  if (remove) {
    if (!existing) return { status: "absent" };
    if (dryRun) return { status: "would-remove", path };
    const saved = backup(path, env);
    delete current[key][NAME];
    writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
    return { status: "removed", path, backup: saved };
  }

  const desired = serverEntry(agent.shape);
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
    return { status: "current", path };
  }
  if (dryRun) return { status: existing ? "would-update" : "would-add", path };

  const saved = exists(path) ? backup(path, env) : null;
  mkdirSync(dirname(path), { recursive: true });
  current[key] ??= {};
  current[key][NAME] = desired;
  // opencode reads skills from explicit paths, so point it at the shared store.
  if (agent.id === "opencode") {
    current.skills ??= {};
    current.skills.paths ??= [];
    if (!current.skills.paths.includes(SHARED_SKILL_STORE())) current.skills.paths.push(SHARED_SKILL_STORE());
  }
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  return { status: existing ? "updated" : "added", path, backup: saved };
}

/**
 * Codex uses TOML. Rather than depend on a TOML writer, append the table when
 * it is absent and refuse to rewrite one that already exists — an edit we
 * cannot make safely is reported, not guessed at.
 */
function writeTomlMcp(agent, { dryRun, env, remove }) {
  const path = agent.config();
  if (!exists(path)) return { status: "skipped", detail: "config file is missing" };
  const text = readFileSync(path, "utf8");
  const header = `[mcp_servers.${NAME}]`;
  const present = text.includes(header);

  if (remove) {
    if (!present) return { status: "absent" };
    return { status: "manual", path, detail: `remove the ${header} table by hand` };
  }
  if (present) return { status: "current", path };
  if (dryRun) return { status: "would-add", path };

  const { command, args } = launchCommand(SERVER_ENTRY);
  const block =
    `\n${header}\n` +
    `command = ${JSON.stringify(command)}\n` +
    `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n` +
    `startup_timeout_sec = 120\n`;
  const saved = backup(path, env);
  writeFileSync(path, text.replace(/\s*$/, "\n") + block);
  return { status: "added", path, backup: saved };
}

/* -------------------------------------------------------------------- skills */

/** Links the bundled skill into a directory, replacing only a link we own. */
function linkSkill(dir, { dryRun, remove }) {
  const target = join(dir, "use-jev");
  let there = null;
  try {
    there = lstatSync(target);
  } catch {
    there = null; // nothing there yet
  }

  if (remove) {
    if (!there) return { status: "absent" };
    if (!there.isSymbolicLink()) return { status: "manual", detail: `${tildify(target)} is not a symlink we made` };
    if (dryRun) return { status: "would-remove", path: target };
    unlinkSync(target);
    return { status: "removed", path: target };
  }

  if (there && !there.isSymbolicLink()) return { status: "manual", detail: `${tildify(target)} exists and is not a symlink` };
  if (dryRun) return { status: there ? "would-relink" : "would-link", path: target };
  mkdirSync(dir, { recursive: true });
  if (there) unlinkSync(target);
  symlinkSync(SKILL_DIR, target, "dir");
  return { status: there ? "relinked" : "linked", path: target };
}

/* ------------------------------------------------------------------- install */

/**
 * Installs (or with `remove`, uninstalls) into every agent whose config file
 * already exists. `dryRun` reports the same plan without touching anything.
 */
export function install({ dryRun = false, remove = false, only = null, skills = true, env = process.env } = {}) {
  const results = [];

  for (const agent of AGENTS) {
    if (only && !only.includes(agent.id)) continue;
    const detected = agent.detect ? agent.detect() : exists(agent.config());
    if (!detected) {
      results.push({ agent: agent.label, id: agent.id, mcp: { status: "not-installed" }, skill: { status: "not-installed" } });
      continue;
    }
    const mcp =
      agent.shape === "toml-mcpServers"
        ? writeTomlMcp(agent, { dryRun, env, remove })
        : writeJsonMcp(agent, { dryRun, env, remove });

    // opencode reads the shared store rather than its own directory.
    const skill =
      !skills || agent.id === "opencode"
        ? { status: skills ? "via-shared-store" : "skipped" }
        : linkSkill(agent.skills(), { dryRun, remove });

    results.push({ agent: agent.label, id: agent.id, verified: agent.verified, mcp, skill });
  }

  const shared = skills ? linkSkill(SHARED_SKILL_STORE(), { dryRun, remove }) : { status: "skipped" };
  return { results, shared, dryRun, remove };
}

/** The PreToolUse hook fragment, with this install's own paths filled in. */
export function hookFragment() {
  const { command, args } = launchCommand(CLI_ENTRY);
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Write|Edit",
          hooks: [
            {
              type: "command",
              command: [command, ...args, "gate", "--hook"].join(" "),
              timeout: 30,
              statusMessage: "Jev gate: risk-checking this action",
            },
          ],
        },
      ],
    },
  };
}

/** Agent skill directories that exist on this machine, for reporting. */
export function detectedSkillDirs() {
  const dirs = [SHARED_SKILL_STORE(), ...AGENTS.map((a) => a.skills())];
  return dirs.filter((d) => exists(d)).map((d) => ({ dir: d, entries: readdirSync(d).length }));
}

export { SHARED_SKILL_STORE, dirname };
