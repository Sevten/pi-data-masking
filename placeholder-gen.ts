/**
 * placeholder-gen.ts
 * Session key management + format-preserving placeholder generation.
 *
 * Algorithm: HMAC(sessionKey, real) derives a deterministic byte stream, then
 * each character is mapped by type (upper->upper, lower->lower, digit->digit,
 * separators kept as-is).
 *
 * Connection strings: known schemes (postgresql://, mysql://, ...) keep the
 * scheme, port, and path; only userinfo and host are replaced.
 *
 * IPv4 addresses: a plain per-character replacement can't guarantee each
 * octet stays within 0-255 (e.g. "172" could become "988"). When real is
 * exactly a valid IPv4 address, each octet is generated independently in
 * 0-255 so the placeholder is always syntactically valid.
 *
 * Same real + same sessionKey always yields the same placeholder, so
 * Masker's unmask logic needs no extra bookkeeping for literal rules.
 *
 * Used in two contexts:
 *  1. Literal rules — config-loader.ts calls this once at load time.
 *  2. Regex rules — masker.ts calls this at runtime for each newly matched
 *     value, since the real value isn't known until a match occurs.
 *
 * Collision protection: an optional `attempt` parameter perturbs the HMAC
 * input. The caller (masker.ts) retries with an incremented attempt when a
 * generated placeholder collides with one already in use.
 */

import { createHmac, randomBytes } from "node:crypto";

// ─── Character sets ───────────────────────────────────────────────────────

const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const DIGITS    = "0123456789";

// ─── Known URI schemes ────────────────────────────────────────────────────

const KNOWN_SCHEMES = [
  "postgresql", "mysql", "mariadb", "redis", "mongodb",
  "amqp", "amqps", "https", "http", "ftp", "sftp",
];

// ─── Public API ───────────────────────────────────────────────────────────

/** Generate a session key once per session_start. */
export function generateSessionKey(): Buffer {
  return randomBytes(32);
}

/** Options controlling which structural properties of the real value are
 *  preserved in the placeholder (mirrors PreserveStructure in masker.ts).
 *  Preserving structure keeps claims like "starts with gs-" true in the
 *  LLM's view; the kept parts are category markers / non-secret scaffolding,
 *  never the secret entropy. */
export interface PlaceholderOptions {
  /** Keep the first segment (up to the first separator) of the real value
   *  as-is; a number caps how many characters of that segment are kept. */
  keepPrefix?: boolean | number;
  /** For exact IPv4 values: keep the first N octets as-is (recommended 2
   *  for private ranges); remaining octets are randomized within 0-255. */
  keepIPv4Octets?: number;
}

/**
 * Generate a format-preserving placeholder for a real value.
 * Same real + same sessionKey + same attempt always yields the same result.
 *
 * @param attempt Collision-retry counter, default 0. Caller increments it
 *                when the result collides with an already-used placeholder.
 * @param opts    Structure preservation options (keepPrefix / keepIPv4Octets).
 */
export function generatePlaceholder(
  real: string,
  sessionKey: Buffer,
  attempt = 0,
  opts: PlaceholderOptions = {}
): string {
  const bytes = deriveKeyStream(sessionKey, real, real.length + 64, attempt);

  for (const scheme of KNOWN_SCHEMES) {
    if (real.startsWith(scheme + "://")) {
      return replaceConnectionString(real, scheme + "://", bytes);
    }
  }

  const ipv4Placeholder = replaceIPv4(real, bytes, opts.keepIPv4Octets);
  if (ipv4Placeholder !== null) return ipv4Placeholder;

  // Default: format-preserving replacement over the whole string, optionally
  // keeping the first segment so prefix claims stay true. The byte stream is
  // derived from the FULL real value, so determinism is unaffected; bytes for
  // the kept prefix positions are simply unused.
  const { prefix, body } = splitPrefix(real, opts.keepPrefix);
  let result = prefix;
  for (let i = 0; i < body.length; i++) {
    result += fprChar(body[i], bytes[prefix.length + i]);
  }
  return result;
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Derive a deterministic byte stream. Each HMAC round yields 32 bytes;
 * rounds are concatenated until the requested length is reached. `round`
 * acts as a nonce so rounds are independent; `attempt` is mixed in too so
 * collision retries get an unrelated byte stream.
 */
function deriveKeyStream(
  sessionKey: Buffer,
  real: string,
  length: number,
  attempt = 0
): number[] {
  const bytes: number[] = [];
  let round = 0;
  while (bytes.length < length) {
    const h = createHmac("sha256", sessionKey);
    h.update(`${attempt}:${round}:${real}`);
    bytes.push(...Array.from(h.digest()));
    round++;
  }
  return bytes;
}

/**
 * If real is exactly a valid IPv4 address (four octets, 0-255 each),
 * generate a placeholder by picking a random byte (already 0-255) per
 * octet. Returns null otherwise so the caller falls back to generic FPR.
 * With keepOctets > 0, the leading octets are kept as-is (clamped so at
 * least one octet is always randomized) — e.g. 2 for private ranges, where
 * the network prefix is not the secret, the host is.
 */
function replaceIPv4(real: string, bytes: number[], keepOctets = 0): string | null {
  const m = real.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;

  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return null; // not a valid IPv4, treat as plain text

  const kept = Math.min(Math.max(0, Math.floor(keepOctets)), 3);
  return [0, 1, 2, 3]
    .map((i) => (i < kept ? String(octets[i]) : String(bytes[i])))
    .join(".");
}

/**
 * Split off the keepable prefix of a generic value: the first segment up to
 * (and including) the first separator (- _ . : / @). A numeric cap limits
 * how many characters are kept. When nothing would remain to be randomized
 * (single-segment values), the whole value is randomized instead, so
 * keepPrefix never yields a placeholder identical to the real value.
 */
function splitPrefix(
  real: string,
  keepPrefix: boolean | number | undefined
): { prefix: string; body: string } {
  if (!keepPrefix) return { prefix: "", body: real };
  const m = real.match(/^([^\-_.:/@]*[\-_.:/@]?)/);
  const segmentEnd = m ? m[1].length : 0;
  if (segmentEnd >= real.length) return { prefix: "", body: real };
  const keep = typeof keepPrefix === "number" ? Math.max(0, keepPrefix) : segmentEnd;
  const n = Math.min(keep, segmentEnd);
  return { prefix: real.slice(0, n), body: real.slice(n) };
}

/** Single-character format-preserving replacement */
function fprChar(ch: string, byte: number): string {
  if (ch >= "A" && ch <= "Z") return UPPERCASE[byte % 26];
  if (ch >= "a" && ch <= "z") return LOWERCASE[byte % 26];
  if (ch >= "0" && ch <= "9") return DIGITS[byte % 10];
  return ch; // separators / special chars kept as-is
}

/**
 * Format-preserving replacement for connection strings.
 * `bytes` is indexed by position in the original string so each segment is
 * randomized independently.
 *
 * Strategy:
 *   scheme://  → kept as-is (protocol identifier)
 *   userinfo   → replaced (the "admin:password" part)
 *   @          → kept as-is (separator)
 *   host       → replaced
 *   :port/path → kept as-is (structural, the LLM needs it for context)
 */
function replaceConnectionString(
  real: string,
  prefix: string,
  bytes: number[]
): string {
  const rest = real.slice(prefix.length);
  const result: string[] = [prefix]; // scheme written as-is
  let pos = prefix.length;           // byte-stream offset follows original position

  const atIdx = rest.lastIndexOf("@");

  if (atIdx !== -1) {
    // Has userinfo: replace it, keep the @
    const userinfo = rest.slice(0, atIdx);
    for (let i = 0; i < userinfo.length; i++) {
      result.push(fprChar(userinfo[i], bytes[pos + i]));
    }
    result.push("@");
    pos += userinfo.length + 1; // +1 to skip @

    // Replace host, keep :port/path
    const hostAndPath = rest.slice(atIdx + 1);
    const m = hostAndPath.match(/^([^:/?#]+)(.*)/s);
    if (m) {
      const [, host, remainder] = m;
      for (let i = 0; i < host.length; i++) {
        result.push(fprChar(host[i], bytes[pos + i]));
      }
      result.push(remainder); // :5432/prod kept as-is
    } else {
      result.push(hostAndPath);
    }
  } else {
    // No userinfo: replace host only, keep :port/path
    const m = rest.match(/^([^:/?#]+)(.*)/s);
    if (m) {
      const [, host, remainder] = m;
      for (let i = 0; i < host.length; i++) {
        result.push(fprChar(host[i], bytes[pos + i]));
      }
      result.push(remainder);
    } else {
      result.push(rest);
    }
  }

  return result.join("");
}
