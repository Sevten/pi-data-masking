/**
 * Network-signature detection: does this command text carry outbound intent
 * even when no destination can be extracted from it (URL behind a variable,
 * config-driven upload)? One shared signal for both enforcement dimensions:
 *
 *  - rule scope (egress-decision): "signature but no destination" is the
 *    detection-gap cell — blocked under strict, restored with a warning
 *    under semi-strict/permissive;
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
  // DNS resolution family: encoded-subdomain exfiltration rides DNS
  // queries; the domain charset forces encoding (naturally obfuscated)
  // and the attacker's bare domain is not extracted by design, so
  // without these the calls land in the permissive blind spot.
  "dig",
  "nslookup",
  "host",
  "resolvectl",
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

/**
 * Consumer table: commands that can execute code or load the environment,
 * whose own network behavior is not observable from the arguments
 * (`python x.py` reading a marked file, `source .env` pulling values into
 * the process environment). This is NOT an outbound signature — it never
 * blocks. It marks the point where the marker chain's observability ends:
 * a marked path (or restored placeholder) handed to one of these gets a
 * one-time warning, nothing more.
 *
 * Deliberately excluded: pure text tools (cat/sed/awk — no network
 * behavior to hide), outbound tools (curl/ssh — the signature table wins),
 * and context consumers (git/docker — they swallow marked files via
 * directories, and matching that would require directory-containment
 * checks whose noise explodes; documented residual risk).
 */
const CONSUMERS = new Set([
  "python",
  "python3",
  "node",
  "nodejs",
  "bash",
  "sh",
  "zsh",
  "perl",
  "ruby",
  "php",
  "java",
  "source",
  ".",
  "envsubst",
]);

/** The consumer command word found at command position, if any. */
export function consumerSignatureWord(command: string): string | undefined {
  return commandWords(command).find((word) => CONSUMERS.has(word));
}
