/**
 * Everything location-dependent, resolved at runtime from this file's own URL.
 *
 * Nothing in this package hard-codes an install directory, a Node path or a
 * home directory: move the checkout, install it from npm, or run it with a
 * different Node and every path below follows.
 */

import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/** The package root — the directory holding package.json. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SERVER_ENTRY = join(PACKAGE_ROOT, "index.mjs");
export const CLI_ENTRY = join(PACKAGE_ROOT, "cli.mjs");
export const SKILL_DIR = join(PACKAGE_ROOT, "skills", "use-jev");

/**
 * A Node path durable enough to write into someone else's config file.
 *
 * `process.execPath` is exact but often version-pinned — Homebrew resolves to
 * .../Cellar/node/25.8.1_1/bin/node, which disappears on the next upgrade and
 * silently breaks every agent that launched us through it. So prefer a `node`
 * found on PATH whose version matches the one running, and fall back to the
 * exact path only when nothing on PATH agrees. Bare "node" is never used: an
 * agent started from a GUI usually has no useful PATH.
 */
function durableNodePath() {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, process.platform === "win32" ? "node.exe" : "node");
    if (candidate === process.execPath || !existsSync(candidate)) continue;
    try {
      if (execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 }).trim() === process.version) {
        return candidate;
      }
    } catch {
      /* not a usable node; keep looking */
    }
  }
  return process.execPath;
}

export const NODE_BIN = durableNodePath();

export const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

/** The npm package, scope included — what `npx` needs. */
export const PKG_NAME = pkg.name;

/**
 * The MCP server's name: the package name without its scope.
 *
 * These are deliberately separate. The npm name carries a scope because the
 * unscoped one was taken, but the scope must not leak into the server name —
 * it keys every agent's config and every tool (mcp__use-jev__jev_ask), and a
 * "@" or "/" in there would break permission rules and rename the tools.
 */
export const NAME = pkg.name.replace(/^@[^/]+\//, "");
export const VERSION = pkg.version;

/** Expands a leading ~ so config files may use it. */
export const expandHome = (p) => (p?.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Prints a path with the home directory collapsed back to ~, for readable output. */
export const tildify = (p) => (p?.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

/**
 * How another process should invoke this package.
 *
 * A checkout is invoked through the Node binary currently running, because a
 * git clone has no bin on PATH. An npm install resolves to the published name,
 * so the command survives version upgrades and a moved node_modules.
 */
export function launchCommand(entry = SERVER_ENTRY) {
  const installedFromRegistry = PACKAGE_ROOT.includes(join("node_modules", ...PKG_NAME.split("/")));
  if (installedFromRegistry) {
    return { command: "npx", args: ["-y", `${PKG_NAME}@${VERSION}`, entry === CLI_ENTRY ? "" : "serve"].filter(Boolean) };
  }
  return { command: NODE_BIN, args: [entry] };
}

/** Where a user's own configuration lives; overridable for tests and sandboxes. */
export const configHome = (env = process.env) => expandHome(env.USE_JEV_HOME ?? join(homedir(), ".use-jev"));

export const defaultConfigPath = (env = process.env) =>
  expandHome(env.USE_JEV_CONFIG ?? join(configHome(env), "config.json"));

export const exists = existsSync;
