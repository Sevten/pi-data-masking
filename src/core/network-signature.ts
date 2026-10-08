/**
 * Network-signature detection: does this command text carry outbound intent
 * even when no destination can be extracted from it (URL behind a variable,
 * config-driven upload)? One shared signal for both enforcement dimensions:
 *
 *  - rule scope (egress-decision): "signature but no destination" is treated
 *    as destination-present-but-unmatched — held in both modes;
 *  - file markers (Phase 2): signature + referenced marked path triggers the
 *    marked rules' scope check.
 *
 * This is a denylist signal: it recognizes known outbound tool names at
 * command position only (first token of each `;`/`&&`/`|`/newline segment,
 * optional path prefix allowed). Allowlist-grade assurance needs the
 * per-rule/per-path tool allowlists, not a longer list here.
 */

const SIGNATURES = new Set([
  "curl",
  "wget",
  "wget2",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "ftps",
  "telnet",
  "rsync",
  "fetch",
  "http",
  "https",
]);

/** First word of a segment, with a leading absolute/relative path stripped
 *  (`/usr/bin/curl` → `curl`, `./xssh` stays `xssh` — only unambiguous
 *  path prefixes are stripped, no fuzzy matching). */
function firstToken(segment: string): string {
  const token = segment.trim().split(/\s+/)[0] ?? "";
  const lastSlash = token.lastIndexOf("/");
  return lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
}

/** Split a command into segments at shell separators and take the command
 *  word of each: `cd /tmp && curl …` yields `cd` and `curl`. */
function commandWords(command: string): string[] {
  return command
    .split(/;|&&|\|\||\||\n|&>/)
    .map(firstToken)
    .filter((word) => word.length > 0);
}

/** True when the command text runs a known outbound tool at command
 *  position. Plain-text mentions (`grep curl notes.md`, `echo wget`) do not
 *  match — the token must be in command position of some segment. */
export function hasNetworkSignature(command: string): boolean {
  return commandWords(command).some((word) => SIGNATURES.has(word));
}
