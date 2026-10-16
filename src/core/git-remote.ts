/**
 * Git-remote and gh destination resolution (plan: hub
 * docs/egress-hardening-plan.zh.md §B1/§B2).
 *
 * `git push origin main` carries no host in its arguments — the destination
 * lives in the repository's remote configuration. Without resolution the call
 * is a network signature with no extractable destination (detection-gap cell),
 * which refuses every legitimate push under strict/semi-strict. Resolution
 * turns the remote name into a verifiable host:
 *
 *  - {kind:"local"}   — path/`file://` remotes (local bare repos): no network,
 *    the git signature is cleared and the call is governed as local use;
 *  - {kind:"host"}    — ssh/https/git remotes: the host joins the call's
 *    destination set and the normal allowlist matching decides;
 *  - {kind:"unknown"} — unresolvable (no config entry, odd syntax): the call
 *    stays in the detection-gap cell (safe by construction).
 *
 * Best-effort by design: the config is read from the tool-call cwd (a `cd`
 * inside the same command is not followed), and resolution never exposes
 * config contents beyond the host. Single-label intranet hosts (`yor-agent`)
 * are valid hosts — normalizeHost accepts them; only the free-form scanner
 * would miss them.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeHost } from "./restore-scope.ts";

/** Git subcommands that contact a remote (and are therefore signatures). */
export const GIT_REMOTE_SUBCOMMANDS = new Set([
  "push",
  "fetch",
  "pull",
  "clone",
  "ls-remote",
]);

export type GitRemoteResolution =
  | { kind: "host"; host: string }
  | { kind: "local" }
  | { kind: "unknown" };

/** Split a command text into whitespace tokens per shell segment. Not
 *  quote-aware beyond stripping outer quotes — remote names and URLs are
 *  unquoted in practice, and anything odd degrades to unknown. */
function segments(command: string): string[][] {
  return command
    .split(/[;\n|&]+/)
    .map((segment) =>
      segment
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .map((token) => token.replace(/^['"]+/, "").replace(/['"]+$/, "")),
    )
    .filter((tokens) => tokens.length > 0);
}

/** Find the first git invocation with a remote-contacting subcommand:
 *  returns the subcommand, the remote token (first non-flag word after it),
 *  and the `-C` directory if given. */
export function parseGitInvocation(
  command: string,
): { sub: string; remote: string | undefined; dir: string | undefined } | undefined {
  for (const tokens of segments(command)) {
    let i = 0;
    // Wrapper prefixes (sudo, env …) are skipped like the signature table.
    while (i < tokens.length && /^(sudo|doas|nohup|timeout|env)$/.test(tokens[i]!.toLowerCase())) i++;
    const head = tokens[i];
    if (!head) continue;
    const base = head.slice(Math.max(0, head.lastIndexOf("/") + 1)).toLowerCase();
    if (base !== "git") continue;
    i++;
    let dir: string | undefined;
    let sub: string | undefined;
    for (; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "-C" && tokens[i + 1]) {
        dir = tokens[i + 1];
        i++;
        continue;
      }
      if (token.startsWith("-")) continue; // other global flags (values vary)
      sub = token.toLowerCase();
      break;
    }
    if (!sub || !GIT_REMOTE_SUBCOMMANDS.has(sub)) continue;
    i++; // step past the subcommand token
    let remote: string | undefined;
    for (; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.startsWith("-")) continue;
      remote = token;
      break;
    }
    return { sub, remote, dir };
  }
  return undefined;
}

/** Classify a remote URL without config lookup. */
export function classifyRemoteUrl(url: string): GitRemoteResolution {
  const trimmed = url.trim().replace(/^['"]+/, "").replace(/['"]+$/, "");
  if (!trimmed) return { kind: "unknown" };

  // Scheme forms: file:// is local; others yield the URL hostname.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme) {
    if (scheme[1]!.toLowerCase() === "file") return { kind: "local" };
    try {
      const host = new URL(trimmed).hostname;
      if (!host) return { kind: "unknown" };
      const normalized = normalizeHost(host);
      return normalized ? { kind: "host", host: normalized } : { kind: "unknown" };
    } catch {
      return { kind: "unknown" };
    }
  }

  // Path forms: absolute, home-relative, or relative → local bare repo.
  if (/^[.~]/.test(trimmed) || trimmed.startsWith("/")) return { kind: "local" };

  // scp-style [user@]host:path — but not Windows drive letters (C:\…).
  const scp = /^(?:[^@/]+@)?([^:/?]+):(.*)$/.exec(trimmed);
  if (scp && !/^[A-Za-z]$/.test(scp[1]!)) {
    const host = normalizeHost(scp[1]!);
    if (host) return { kind: "host", host };
  }

  return { kind: "unknown" };
}

/** Parse `.git/config` for `[remote "<name>"]` url values. Tolerant:
 *  only the requested remote's url is read; anything else is ignored. */
export function remoteUrlFromConfig(configText: string, name: string): string | undefined {
  const section = new RegExp(
    `\\[remote\\s+"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\]`,
  );
  const match = section.exec(configText);
  if (!match) return undefined;
  const rest = configText.slice(match.index + match[0].length);
  const nextSection = rest.search(/\[/);
  const body = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  const url = /^\s*url\s*=\s*(.+)$/m.exec(body);
  return url?.[1]?.trim();
}

/**
 * Resolve the destination of the first remote-contacting git invocation in
 * the command. `readFile` is injectable for tests.
 */
export function resolveGitRemote(
  command: string,
  cwd: string,
  readFile: (path: string) => string | null = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
): GitRemoteResolution {
  const invocation = parseGitInvocation(command);
  if (!invocation) return { kind: "unknown" };
  const repoDir = invocation.dir ? resolve(cwd, invocation.dir) : cwd;

  // A URL/path-shaped remote token classifies directly (git push https://…,
  // git clone /srv/…); a bare name needs the config.
  const remote = invocation.remote;
  if (remote && (remote.includes("://") || /^[.~/]/.test(remote) || remote.includes(":"))) {
    return classifyRemoteUrl(remote);
  }

  const config = readFile(join(repoDir, ".git", "config"));
  if (config === null) return { kind: "unknown" };
  // No remote token: git push/fetch default to the branch upstream; the
  // overwhelmingly common case is "origin" — best-effort, unknown otherwise.
  const name = remote ?? "origin";
  const url = remoteUrlFromConfig(config, name);
  if (!url) return { kind: "unknown" };
  return classifyRemoteUrl(url);
}

/**
 * The host `gh` talks to for this command: `--hostname <h>` (GitHub
 * Enterprise flag), the GH_HOST environment variable, or the default
 * api host. Literal `--hostname` values are visible in the arguments;
 * a session-mid `export GH_HOST` is not (documented degradation — the
 * default is still added, and a rule that does not allowlist it refuses).
 */
export function ghDestinationHost(
  command: string,
  env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
): string | undefined {
  const runsGh = segments(command).some((tokens) => {
    let i = 0;
    while (i < tokens.length && /^(sudo|doas|nohup|timeout|env)$/.test(tokens[i]!.toLowerCase())) i++;
    const head = tokens[i] ?? "";
    return head.slice(Math.max(0, head.lastIndexOf("/") + 1)).toLowerCase().replace(/\.exe$/, "") === "gh";
  });
  if (!runsGh) return undefined;
  const explicit = /--hostname(?:=|\s+)['"]?([^\s'"]+)/i.exec(command)?.[1];
  const candidate = explicit ?? env["GH_HOST"] ?? "github.com";
  const normalized = normalizeHost(candidate);
  return normalized ?? "github.com";
}
