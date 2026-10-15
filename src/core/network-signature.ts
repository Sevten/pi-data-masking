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
  // Windows / TLS Swiss-army additions. PowerShell cmdlets are stored
  // lowercase; lookups are case-insensitive (firstToken output is
  // lowercased before table checks).
  "invoke-webrequest",
  "iwr",
  "invoke-restmethod",
  "irm",
  "socat",
]);

/** Command-position words that wrap the real command (privilege,
 *  scheduling, environment plumbing). Transparency: the wrapper is
 *  skipped so the wrapped tool lands in command position —
 *  `sudo curl …` must register like `curl …`. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "nohup",
  "setsid",
  "stdbuf",
  "taskset",
  "ionice",
  "nice",
  "strace",
  "ltrace",
  "env",
  "xargs",
  "timeout",
]);

/** Shells whose `-c`/`-Command` payload is a command text of its own:
 *  `bash -c 'curl …'` is scanned as `bash` plus the payload's segments. */
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh", "powershell", "pwsh"]);

/** First word of a segment, with a leading absolute/relative path stripped
 *  (`/usr/bin/curl` → `curl`, `./xssh` stays `xssh` — only unambiguous
 *  path prefixes are stripped, no fuzzy matching). Windows forms are
 *  normalized: backslash paths collapse (`C:\Windows\curl.exe` →
 *  `curl`) and a trailing `.exe` is dropped (lowercased). */
function firstToken(segment: string): string {
  const token = segment.trim().split(/\s+/)[0] ?? "";
  const lastSeparator = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const word = lastSeparator >= 0 ? token.slice(lastSeparator + 1) : token;
  // Quoting survives tokenization (`bash -c 'curl …'` → `'curl`): leading
  // and trailing quote characters are not part of the word.
  return word.replace(/^['"]+/, "").replace(/['"]+$/, "").toLowerCase().replace(/\.exe$/, "");
}

/** Words of a segment with leading wrapper prefixes made transparent:
 *  `sudo curl` → [curl]; `timeout 10 curl` → [curl]; `env FOO=1 curl` →
 *  [curl]; `xargs curl` → [curl]. Non-wrapper args (`timeout 10`) are
 *  skipped only where the wrapper's grammar makes them unambiguous. */
function unwrapSegment(segment: string): string[] {
  const raw = segment.trim().split(/\s+/).filter((word) => word.length > 0);
  let i = 0;
  while (i < raw.length) {
    const word = firstToken(raw[i]!);
    if (word === "timeout") {
      i += 2; // the duration argument
      continue;
    }
    if (word === "nice" && raw[i + 1] === "-n") {
      i += 3; // `-n <nice-value>`
      continue;
    }
    if (word === "env") {
      i++;
      while (i < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i]!)) i++;
      continue;
    }
    if (WRAPPERS.has(word)) {
      i++;
      continue;
    }
    break;
  }
  return raw.slice(i);
}

/** Inner command texts of `$( … )`, backticks and `>( … )` process
 *  substitution, one level extracted per pass (callers re-feed them).
 *  Deliberately shallow: `depth` counting covers nested `$( )` only —
 *  quoted/unterminated forms degrade to no match, never to a false one. */
function subShellTexts(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("$(", i) || text.startsWith(">(", i) || text.startsWith("<(", i)) {
      const open = i + 1;
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text.startsWith("$(", j) || text.startsWith(">(", j)) depth++;
        else if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
        j++;
      }
      if (depth === 0) out.push(text.slice(open + 1, j - 1));
      i = Math.max(j - 1, open);
    } else if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        out.push(text.slice(i + 1, end));
        i = end;
      }
    }
  }
  return out;
}

/** Command words of a command text: segments split at shell separators
 *  (`;` `&&` `||` `|` newline and single `&`), wrappers made transparent,
 *  shell `-c` payloads re-scanned, sub-shells included. Bounded: nested
 *  expansion stops after 32 distinct texts. */
function commandWords(command: string): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  const queue = [command];
  while (queue.length > 0 && seen.size < 32) {
    const text = queue.shift()!;
    if (seen.has(text)) continue;
    seen.add(text);
    for (const segment of text.split(/;|&&|\|\||\||\n|&/)) {
      const rest = unwrapSegment(segment);
      if (rest.length === 0) continue;
      words.push(firstToken(rest[0]!));
      const head = firstToken(rest[0]!);
      if (head === "openssl" && rest[1]) {
        // Subcommand word for the s_client check below.
        words.push(firstToken(rest[1]));
      }
      if (SHELLS.has(head)) {
        const flagIndex = rest.findIndex((word, index) =>
          index > 0 && (word === "-c" || word.toLowerCase() === "-command"));
        if (flagIndex >= 0 && rest[flagIndex + 1]) {
          queue.push(rest.slice(flagIndex + 1).join(" "));
        }
      }
    }
    queue.push(...subShellTexts(text));
  }
  return words;
}

/** True when the command text runs a known outbound tool at command
 *  position. Plain-text mentions (`grep curl notes.md`, `echo wget`) do not
 *  match — the token must be in command position of some segment. */
export function hasNetworkSignature(command: string): boolean {
  const words = commandWords(command);
  if (words.some((word) => SIGNATURES.has(word))) return true;
  // openssl is multi-purpose: only its TLS client subcommand is an
  // outbound signature (`openssl s_client -connect host`), not local
  // crypto (`openssl enc`).
  return words.some((word, index) => word === "openssl" && words[index + 1] === "s_client");
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
  // Windows script hosts: same unobservable-network-behavior class.
  "powershell",
  "pwsh",
]);

/** The consumer command word found at command position, if any. */
export function consumerSignatureWord(command: string): string | undefined {
  return commandWords(command).find((word) => CONSUMERS.has(word));
}
