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

import { GIT_REMOTE_SUBCOMMANDS } from "./git-remote.ts";

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
  // Traditional/Windows exfil tools. `tftp` and `bitsadmin` have almost
  // no legitimate agent use; Start-BitsTransfer is the PowerShell form
  // (firstToken lowercases → "start-bitstransfer").
  "tftp",
  "bitsadmin",
  "start-bitstransfer",
  // GitHub CLI: always network (its API host is the destination; resolved
  // to a verifiable host by ghDestinationHost, plan §B2).
  "gh",
]);

/** Multi-word signatures: a general-purpose CLI is an outbound signature
 *  only with the subcommand that leaves the machine (`npm publish`, not
 *  `npm install`; `getent hosts`, not `getent passwd`; `certutil
 *  -urlcache`, not `certutil -decode`). Matched as word followed by
 *  subcommand in the flattened command-word list. */
const SUBCOMMAND_SIGNATURES: ReadonlyArray<readonly [string, string]> = [
  ["npm", "publish"],
  ["pnpm", "publish"],
  ["yarn", "publish"],
  ["twine", "upload"],
  ["cargo", "publish"],
  ["getent", "hosts"],
  ["certutil", "-urlcache"],
];

/** First non-flag token after `git` (skipping `-C <dir>` / `-c <kv>`
 *  global flags): the subcommand position for the git pair check. */
function gitSubcommand(rest: string[]): string | undefined {
  for (let i = 1; i < rest.length; i++) {
    const token = firstToken(rest[i]!);
    if (token === "-c" || token === "-C") {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

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

/**
 * Interpreters whose inline-code flags carry executable payloads with
 * first-class network capability (`python -c "requests.post(…)"`).
 * Without this, interpreter words sit in the CONSUMERS table (warn-only)
 * and inline exfil code lands in the local cell — restored under
 * semi-strict with nothing more than a warning. When the payload shows
 * network features the call is upgraded to a network signature: the
 * detection-gap cell (or destination matching, when a literal host is
 * present) governs it. Payloads without network features degrade to the
 * previous consumer behavior, never to a false signature.
 *
 * Detection is a raw-text scan anchored at command position (line start
 * or after a shell separator / sub-shell open, wrappers transparent) and
 * quote-aware: the payload is read from its opening quote to its closing
 * quote, so separators inside quotes do not truncate it (the segment
 * splitter is not quote-aware). Mentions inside data (`echo 'python -c
 * "…"'`) are not matches — the interpreter word must actually start a
 * segment. Unquoted payloads and base64 `-EncodedCommand` are documented
 * degradations (no match, never a false one).
 */
const WRAPPER_PREFIX =
  "(?:(?:sudo|doas|nohup|setsid|stdbuf|taskset|ionice|nice|strace|ltrace|" +
  "timeout\\s+\\S+|env(?:\\s+[A-Za-z_][A-Za-z0-9_]*=\\S+)*)\\s+)*";
/** Segment-start anchor: line start, shell separator, or sub-shell open. */
const SEGMENT_START = "(?:^|[;&|\\n(])\\s*";
const INTERPRETERS = "python3?|nodejs|node|perl|ruby|php|deno|powershell|pwsh";
const INLINE_FLAGS =
  "-c\\b|-e\\b|--eval\\b|-p\\b|--print\\b|-r\\b|--command\\b|-commandstring\\b|\\beval\\b";
/** Quoted payload, quote-aware: one alternative per quote character so
 *  the other quote type may appear inside. Payload = group 1 or 2. */
const QUOTED_PAYLOAD =
  "(?:\"((?:[^\"\\\\]|\\\\.)*)\"|'((?:[^'\\\\]|\\\\.)*)')";
const INLINE_SCAN = new RegExp(
  SEGMENT_START +
    WRAPPER_PREFIX +
    `(?:${INTERPRETERS})\\s+(?:-\\S+\\s+)*(?:${INLINE_FLAGS})\\s+` +
    QUOTED_PAYLOAD,
  "gi",
);
/** awk is not a pure text tool: gawk reaches the network through
 *  `/inet/...` streams and executes through `system()`. An awk program
 *  text (first quoted argument at command position) showing either is
 *  upgraded to a network signature. */
const AWK_SCAN = new RegExp(
  SEGMENT_START + WRAPPER_PREFIX + "(?:gawk|mawk|awk)\\s+(?:-\\S+\\s+)*" + QUOTED_PAYLOAD,
  "gi",
);
const AWK_PROGRAM_FEATURE = /\/inet\/|\bsystem\s*\(/;

/** Network-capability markers inside an inline-code payload: URL schemes,
 *  HTTP/socket/DNS library names, and connection calls. Deliberately
 *  narrow — a false signature would refuse legitimate local inline code
 *  under strict/semi-strict; a missed one only degrades to the consumer
 *  warning that exists today. */
const NETWORK_FEATURE =
  /https?:\/\/|\bsocket\b|\burllib\b|\brequests\b|\baiohttp\b|\bhttp\.client\b|\burlopen\b|\bcreate_connection\b|\bgetaddrinfo\b|\bfetch\s*\(|\baxios\b|\bdns\b|\bconnect\s*\(/i;

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
function commandHeads(command: string): { word: string; rest: string[] }[] {
  const heads: { word: string; rest: string[] }[] = [];
  const seen = new Set<string>();
  const queue = [command];
  while (queue.length > 0 && seen.size < 32) {
    const text = queue.shift()!;
    if (seen.has(text)) continue;
    seen.add(text);
    for (const segment of text.split(/;|&&|\|\||\||\n|&/)) {
      const rest = unwrapSegment(segment);
      if (rest.length === 0) continue;
      const head = firstToken(rest[0]!);
      heads.push({ word: head, rest });
      if (head === "openssl" && rest[1]) {
        // Subcommand word for the s_client check below.
        heads.push({ word: firstToken(rest[1]), rest: rest.slice(1) });
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
  return heads;
}

function commandWords(command: string): string[] {
  return commandHeads(command).map((head) => head.word);
}

/** True when the command text carries an interpreter/awk inline payload
 *  with network features (quote-aware scan, see INLINE_SCAN). */
function hasInlineNetworkCode(command: string): boolean {
  for (const match of command.matchAll(INLINE_SCAN)) {
    const payload = match[1] ?? match[2] ?? "";
    if (NETWORK_FEATURE.test(payload)) return true;
  }
  for (const match of command.matchAll(AWK_SCAN)) {
    const payload = match[1] ?? match[2] ?? "";
    if (AWK_PROGRAM_FEATURE.test(payload)) return true;
  }
  return false;
}

/** True when the command text runs a known outbound tool at command
 *  position (single-word or subcommand-paired), an eval/variable head
 *  (the real command is not observable — detection-gap cell), or an
 *  interpreter/awk inline payload with network features. Plain-text
 *  mentions (`grep curl notes.md`, `echo wget`) do not match — the token
 *  must be in command position of some segment. */
export function hasNetworkSignature(command: string, gitRemoteLocal = false): boolean {
  const heads = commandHeads(command);
  const words = heads.map((head) => head.word);
  if (words.some((word) => SIGNATURES.has(word))) return true;
  if (
    heads.some(({ word, rest }) => {
      if (word === "git") {
        // A locally resolved remote (bare repo path) is not egress.
        if (gitRemoteLocal) return false;
        const sub = gitSubcommand(rest);
        return sub !== undefined && GIT_REMOTE_SUBCOMMANDS.has(sub);
      }
      return (
        rest[1] !== undefined &&
        SUBCOMMAND_SIGNATURES.some(([w, sub]) => w === word && firstToken(rest[1]!) === sub)
      );
    })
  ) {
    return true;
  }
  // openssl is multi-purpose: only its TLS client subcommand is an
  // outbound signature (`openssl s_client -connect host`), not local
  // crypto (`openssl enc`).
  if (words.some((word, index) => word === "openssl" && words[index + 1] === "s_client")) {
    return true;
  }
  // eval runs its argument: the outbound tool never appears at command
  // position, so the call is unverifiable by construction. A segment head
  // that is a shell variable reference (`$CMD evil.com`) is the same case.
  // Only well-formed variable names count — bare `$?`/`$$`/`$0` heads and
  // HPC-style non-command words must not degrade legitimate local calls
  // into the detection-gap cell.
  if (
    heads.some(
      ({ word }) =>
        word === "eval" || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(word),
    )
  )
    return true;
  return hasInlineNetworkCode(command);
}

/** True when the command carries curl/wget options that redirect a
 *  verified hostname to an arbitrary address (`--resolve host:port:addr`,
 *  `--connect-to`, or a `-H "Host: …"` header): the extracted destination
 *  is no longer trustworthy, so the call must be governed as
 *  destination-unverifiable (detection-gap cell) instead of verified. */
export function hasDestinationOverride(command: string): boolean {
  return /(?:^|\s)(?:--resolve|--connect-to)(?:\s|=)|\s-H\s+["']?\s*host:|\s--header\s+["']?\s*host:/i.test(command);
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
 * Deliberately excluded: pure text tools (cat/sed — no network behavior
 * to hide; awk is NOT excluded: gawk's `/inet/...` streams and `system()`
 * are covered by the inline-payload upgrade in hasNetworkSignature),
 * outbound tools (curl/ssh — the signature table wins),
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
  // Additional script hosts (same unobservable-network-behavior class).
  "deno",
  "bun",
  "lua",
  "rscript",
  // make runs arbitrary commands from a makefile we do not read.
  "make",
  // Cloud CLIs (plan §B3): their own network behavior is not observable
  // from the arguments — the destination hides behind `s3://bucket/key`
  // URIs and region-default endpoints, so they are the consumer class
  // itself, not a signature: strict refuses (local cell), semi-strict
  // restores with the handoff warning, permissive warns. Putting them in
  // the signature table would refuse every legitimate `aws s3 cp` under
  // semi-strict without ever verifying a real destination.
  "aws",
  "gcloud",
  "az",
  // Windows script hosts: same unobservable-network-behavior class.
  "powershell",
  "pwsh",
]);

/** The consumer command word found at command position, if any. */
export function consumerSignatureWord(command: string): string | undefined {
  return commandWords(command).find((word) => CONSUMERS.has(word));
}
